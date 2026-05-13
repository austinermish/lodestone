import { App, FuzzySuggestModal, Modal, Notice, PluginSettingTab, Setting, TFolder } from "obsidian";
import * as QRCode from "qrcode";
import type VaultCrdtSyncPlugin from "./main";
import { randomBase64Url } from "./utils/base64url";

/** Controls how external disk edits (git, other editors) are imported into CRDT. */
export type ExternalEditPolicy = "always" | "closed-only" | "never";

/** Hub-and-spoke role for this device. */
export type SyncMode = "standalone" | "hub" | "spoke" | "hub+spoke";

/** Metadata about a spoke registered with this hub (mirrored from server for UI). */
export interface SpokeInfo {
	spokeVaultId: string;
	deviceName: string;
	registeredAt: string;
	lastSeen?: string;
}

export interface VaultSyncSettings {
	/** Cloudflare Worker host, e.g. "https://sync.yourdomain.com" */
	host: string;
	/** Shared secret token for auth. */
	token: string;
	/** Unique vault identifier. Generated randomly if empty on first load. */
	vaultId: string;
	/** Human-readable device name shown in awareness/cursors. */
	deviceName: string;
	/** Enable verbose console.log output for debugging. */
	debug: boolean;
	/** Pause propagation of suspicious YAML frontmatter transitions. */
	frontmatterGuardEnabled: boolean;
	/** Comma-separated path prefixes to exclude from sync. */
	excludePatterns: string;
	/** Comma-separated folder paths to sync exclusively. Empty = sync everything. */
	includePaths: string;
	/** Maximum file size in KB to sync via CRDT. Files larger are skipped. */
	maxFileSizeKB: number;
	/**
	 * How to handle external disk modifications (git pull, other editors).
	 *   "always"      — always import into CRDT (default, current behavior)
	 *   "closed-only" — import only for files not open in an editor
	 *   "never"       — never import (CRDT is sole source of truth)
	 */
	externalEditPolicy: ExternalEditPolicy;
	/** Enable attachment (non-markdown) sync via R2 blob store. */
	enableAttachmentSync: boolean;
	/** True once the user has explicitly changed the attachment sync toggle. */
	attachmentSyncExplicitlyConfigured: boolean;
	/** Maximum attachment size in KB. Files larger are skipped. Default 10240 (10 MB). */
	maxAttachmentSizeKB: number;
	/** Number of parallel upload/download slots. */
	attachmentConcurrency: number;
	/** Show remote cursors and selections in the editor. */
	showRemoteCursors: boolean;
	/** Optional repo URL used to deep-link provider-native update pages. */
	updateRepoUrl: string;
	/** Optional default branch for provider-native update links. */
	updateRepoBranch: string;

	// ── Hub-and-spoke ──────────────────────────────────────────────────────
	/** Sync topology role for this device. Default "standalone" = current behaviour. */
	syncMode: SyncMode;
	/** Spoke only: URL of the hub server. */
	spokeHubHost: string;
	/** Spoke only: vault ID of the hub vault. */
	spokeHubVaultId: string;
	/** Spoke only: token for spoke registration (same token as hub's sync token). */
	spokeHubToken: string;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
	host: "",
	token: "",
	vaultId: "",
	deviceName: "",
	debug: false,
	frontmatterGuardEnabled: true,
	excludePatterns: "",
	includePaths: "",
	maxFileSizeKB: 2048,
	externalEditPolicy: "always",
	enableAttachmentSync: true,
	attachmentSyncExplicitlyConfigured: false,
	maxAttachmentSizeKB: 10240,
	// requestUrl cannot be hard-aborted; default to 1 to avoid stacked zombie transfers.
	attachmentConcurrency: 1,
	showRemoteCursors: true,
	updateRepoUrl: "",
	updateRepoBranch: "main",
	syncMode: "standalone",
	spokeHubHost: "",
	spokeHubVaultId: "",
	spokeHubToken: "",
};

const CLOUDFLARE_DEPLOY_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/kavinsood/yaos/tree/main/server";

/** Generate a random vault ID (16 bytes, base64url). */
export function generateVaultId(): string {
	return randomBase64Url(16);
}

/** Returns true if the host URL is unencrypted and not localhost. */
function isInsecureRemoteHost(host: string): boolean {
	if (!host) return false;
	try {
		const url = new URL(host);
		if (url.protocol !== "http:") return false;
		const h = url.hostname;
		if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") return false;
		return true;
	} catch {
		return false;
	}
}

function shortenMiddle(value: string, maxLength = 36): string {
	if (value.length <= maxLength) return value;
	const edge = Math.max(8, Math.floor((maxLength - 3) / 2));
	return `${value.slice(0, edge)}...${value.slice(-edge)}`;
}

function addSectionHeading(containerEl: HTMLElement, title: string): void {
	new Setting(containerEl)
		.setName(title)
		.setHeading();
}

function addCardRow(containerEl: HTMLElement, label: string, value: string): void {
	const row = containerEl.createDiv({ cls: "yaos-settings-card-row" });
	row.createSpan({ text: label, cls: "yaos-settings-card-label" });
	row.createSpan({ text: value, cls: "yaos-settings-card-value" });
}

function statusClass(state: string): string {
	switch (state) {
		case "connected":
			return "is-connected";
		case "offline":
		case "loading":
		case "syncing":
			return "is-busy";
		case "error":
		case "unauthorized":
			return "is-error";
		default:
			return "is-idle";
	}
}

function confirmAction(app: App, title: string, message: string, onConfirm: () => void | Promise<void>): void {
	class InlineConfirm extends Modal {
		onOpen() {
			this.contentEl.createEl("h3", { text: title });
			this.contentEl.createEl("p", { text: message });
			const row = this.contentEl.createDiv({ cls: "modal-button-container" });
			row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
			const confirmBtn = row.createEl("button", { text: "Confirm", cls: "mod-warning" });
			confirmBtn.addEventListener("click", () => {
				this.close();
				void onConfirm();
			});
		}
		onClose() { this.contentEl.empty(); }
	}
	new InlineConfirm(app).open();
}

function createDetailsSection(containerEl: HTMLElement, title: string, open = false): HTMLDetailsElement {
	const detailsEl = containerEl.createEl("details", { cls: "yaos-settings-details" });
	detailsEl.open = open;
	detailsEl.createEl("summary", {
		text: title,
		cls: "yaos-settings-details-summary",
	});
	return detailsEl;
}

class PairDeviceModal extends Modal {
	private qrCanvas: HTMLCanvasElement | null = null;

	constructor(
		app: App,
		private readonly deepLink: string,
		private readonly mobileUrl: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("yaos-pair-device-modal");

		contentEl.createEl("h3", { text: "Pair another device" });
		contentEl.createEl("p", {
			text: "Scan this setup code on your phone to open the setup page. If the plugin is not installed yet, the page will guide you through the beta install flow first.",
			cls: "yaos-modal-copy",
		});

		const qrWrap = contentEl.createDiv({ cls: "yaos-pair-device-qr-wrap" });

		const loadingEl = qrWrap.createEl("div", {
			text: "Generating setup code...",
			cls: "yaos-pair-device-loading",
		});

		this.qrCanvas = qrWrap.createEl("canvas", { cls: "yaos-pair-device-qr-canvas" });
		this.qrCanvas.hidden = true;

		void QRCode.toCanvas(this.qrCanvas, this.mobileUrl, {
			width: 220,
			margin: 1,
			errorCorrectionLevel: "M",
		}).then(() => {
			loadingEl.remove();
			if (this.qrCanvas) {
				this.qrCanvas.hidden = false;
				this.qrCanvas.setAttr("aria-label", "Mobile setup code");
			}
		}).catch(() => {
			loadingEl.setText("Could not generate a setup code.");
			if (this.qrCanvas) {
				this.qrCanvas.remove();
				this.qrCanvas = null;
			}
		});

		const primaryButtons = contentEl.createDiv({ cls: "modal-button-container" });
		primaryButtons.createEl("button", { text: "Copy mobile setup URL" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.mobileUrl).then(
				() => new Notice("Mobile setup URL copied."),
				() => new Notice("Failed to copy the mobile setup URL.", 6000),
			);
		});
		primaryButtons.createEl("button", { text: "Open mobile setup page" }).addEventListener("click", () => {
			window.open(this.mobileUrl, "_blank", "noopener");
		});

		const manualDetails = createDetailsSection(contentEl, "Desktop or manual setup", false);
		const manualBody = manualDetails.createDiv({ cls: "yaos-settings-details-body" });

		manualBody.createEl("h4", { text: "Mobile setup URL" });
		const mobileInput = manualBody.createEl("textarea", { cls: "yaos-settings-modal-textarea" });
		mobileInput.value = this.mobileUrl;
		mobileInput.readOnly = true;
		mobileInput.rows = 3;

		const mobileButtons = manualBody.createDiv({ cls: "modal-button-container" });
		mobileButtons.createEl("button", { text: "Copy mobile setup URL" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.mobileUrl).then(
				() => new Notice("Mobile setup URL copied."),
				() => new Notice("Failed to copy the mobile setup URL.", 6000),
			);
		});
		mobileButtons.createEl("button", { text: "Open mobile setup page" }).addEventListener("click", () => {
			window.open(this.mobileUrl, "_blank", "noopener");
		});

		manualBody.createEl("h4", { text: "Desktop deep link" });
		const deepInput = manualBody.createEl("textarea", { cls: "yaos-settings-modal-textarea" });
		deepInput.value = this.deepLink;
		deepInput.readOnly = true;
		deepInput.rows = 3;

		const deepButtons = manualBody.createDiv({ cls: "modal-button-container" });
		deepButtons.createEl("button", { text: "Copy desktop deep link" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.deepLink).then(
				() => new Notice("Desktop deep link copied."),
				() => new Notice("Failed to copy the desktop deep link.", 6000),
			);
		});

		contentEl.createDiv({ cls: "modal-button-container" })
			.createEl("button", { text: "Close" })
			.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
		this.qrCanvas = null;
	}
}

class RecoveryKitModal extends Modal {
	constructor(app: App, private readonly recoveryKit: string) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("yaos-recovery-kit-modal");

		contentEl.createEl("h3", { text: "Backup connection details" });

		const warning = contentEl.createDiv({ cls: "callout yaos-settings-callout" });
		warning.setAttr("data-callout", "warning");

		const warningTitle = warning.createDiv({ cls: "callout-title" });
		warningTitle.createSpan({ text: "Save this somewhere safe" });

		const warningBody = warning.createDiv({ cls: "callout-content" });
		warningBody.createEl("p", {
			text: "Save this somewhere safe, like a password manager. If you lose all your devices, you will need this exact vault ID and token to recover your notes from your server.",
		});

		const textArea = contentEl.createEl("textarea", { cls: "yaos-settings-modal-textarea" });
		textArea.value = this.recoveryKit;
		textArea.readOnly = true;
		textArea.rows = 10;

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Copy connection details" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.recoveryKit).then(
				() => new Notice("Connection details copied."),
				() => new Notice("Failed to copy the connection details.", 6000),
			);
		});
		buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class FolderPickerModal extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private onChoose: (folder: TFolder) => void) {
		super(app);
		this.setPlaceholder("Type to search folders…");
	}

	getItems(): TFolder[] {
		return this.app.vault.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder)
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(folder: TFolder): string {
		return folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onChoose(folder);
	}
}

function appendFolderPath(current: string, folderPath: string): string {
	const entry = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
	const parts = current ? current.split(",").map((s) => s.trim()).filter(Boolean) : [];
	if (!parts.includes(entry)) parts.push(entry);
	return parts.join(", ");
}

class SpokeInviteModal extends Modal {
	private qrCanvas: HTMLCanvasElement | null = null;

	constructor(
		app: App,
		private readonly hubHost: string,
		private readonly hubVaultId: string,
		private readonly hubToken: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("yaos-pair-device-modal");

		const inviteUrl = `obsidian://yaos?action=spoke&host=${encodeURIComponent(this.hubHost)}&hubVaultId=${encodeURIComponent(this.hubVaultId)}&token=${encodeURIComponent(this.hubToken)}`;

		contentEl.createEl("h3", { text: "Connect a spoke vault" });
		contentEl.createEl("p", {
			text: "On the vault you want to connect as a spoke, open this link. YAOS will fill in the connection details and register automatically.",
			cls: "yaos-modal-copy",
		});

		const qrWrap = contentEl.createDiv({ cls: "yaos-pair-device-qr-wrap" });
		const loadingEl = qrWrap.createEl("div", {
			text: "Generating invite code...",
			cls: "yaos-pair-device-loading",
		});
		this.qrCanvas = qrWrap.createEl("canvas", { cls: "yaos-pair-device-qr-canvas" });
		this.qrCanvas.hidden = true;

		void QRCode.toCanvas(this.qrCanvas, inviteUrl, {
			width: 220,
			margin: 1,
			errorCorrectionLevel: "M",
		}).then(() => {
			loadingEl.remove();
			if (this.qrCanvas) {
				this.qrCanvas.hidden = false;
				this.qrCanvas.setAttr("aria-label", "Spoke invite code");
			}
		}).catch(() => {
			loadingEl.setText("Could not generate a QR code.");
			if (this.qrCanvas) {
				this.qrCanvas.remove();
				this.qrCanvas = null;
			}
		});

		const primaryButtons = contentEl.createDiv({ cls: "modal-button-container" });
		primaryButtons.createEl("button", { text: "Copy invite link" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(inviteUrl).then(
				() => new Notice("Invite link copied."),
				() => new Notice("Copy failed.", 4000),
			);
		});

		const manualDetails = createDetailsSection(contentEl, "Manual setup (copy these to the spoke vault)", false);
		const manualBody = manualDetails.createDiv({ cls: "yaos-settings-details-body" });

		const fields = [
			{ label: "Host URL", value: this.hubHost },
			{ label: "Hub vault ID", value: this.hubVaultId },
			{ label: "Sync token", value: this.hubToken },
		];
		for (const { label, value } of fields) {
			const row = manualBody.createDiv({ cls: "yaos-settings-card-row" });
			row.createSpan({ text: label, cls: "yaos-settings-card-label" });
			const valueEl = row.createEl("input", { type: "text", cls: "yaos-settings-modal-input" });
			valueEl.value = value;
			valueEl.readOnly = true;
		}
		const manualButtons = manualBody.createDiv({ cls: "modal-button-container" });
		manualButtons.createEl("button", { text: "Copy all" }).addEventListener("click", () => {
			const text = fields.map((f) => `${f.label}: ${f.value}`).join("\n");
			void navigator.clipboard.writeText(text).then(
				() => new Notice("Copied."),
				() => new Notice("Copy failed.", 4000),
			);
		});

		contentEl.createDiv({ cls: "modal-button-container" })
			.createEl("button", { text: "Close" })
			.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
		this.qrCanvas = null;
	}
}

export class VaultSyncSettingTab extends PluginSettingTab {
	plugin: VaultCrdtSyncPlugin;

	constructor(app: App, plugin: VaultCrdtSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("yaos-settings-tab");
		const authMode = this.plugin.serverAuthMode;
		const attachmentsAvailable = this.plugin.serverSupportsAttachments;
		const setupIncomplete = !this.plugin.settings.host || !this.plugin.settings.token;
		const syncStatus = this.plugin.getSettingsStatusSummary();
		const { syncMode } = this.plugin.settings;
		const isHub = syncMode === "hub" || syncMode === "hub+spoke";
		const isSpoke = syncMode === "spoke" || syncMode === "hub+spoke";

		// ── Section 1: Connection (always shown) ──────────────────────────────
		const connectionDetails = createDetailsSection(containerEl, "Connection", true);
		const connectionBody = connectionDetails.createDiv({ cls: "yaos-settings-details-body" });

		if (setupIncomplete) {
			const callout = connectionBody.createDiv({ cls: "callout yaos-settings-setup-callout" });
			callout.setAttr("data-callout", "warning");
			callout.createDiv({ cls: "callout-title" }).createSpan({ text: "Connection required" });
			const calloutContent = callout.createDiv({ cls: "callout-content" });
			calloutContent.createEl("p", {
				text: "YAOS needs a Cloudflare Worker (host) to sync your vault. Deployment is free and takes about 15 seconds.",
			});
			calloutContent.createEl("p", {
				text: "After deployment, open your host URL in a browser, claim the server, then use the setup link.",
				cls: "yaos-settings-setup-hint",
			});
			new Setting(calloutContent)
				.setName("Deploy your server")
				.setDesc("Start one-click deployment in your browser.")
				.addButton((button) =>
					button
						.setButtonText("Open deploy page")
						.setCta()
						.onClick(() => {
							window.open(CLOUDFLARE_DEPLOY_URL, "_blank", "noopener");
						}),
				);

			// Manual setup — expanded when no connection is configured
			const manualDetails = createDetailsSection(connectionBody, "Manual setup", true);
			const manualBody = manualDetails.createDiv({ cls: "yaos-settings-details-body" });
			manualBody.createEl("p", {
				text: "Claim your server in the browser, then use the setup link. You can also paste your connection details here directly.",
				cls: "yaos-settings-details-intro",
			});
			this.renderConnectionFields(manualBody, authMode);
		} else {
			// Connected status card
			const card = connectionBody.createDiv({ cls: "yaos-settings-status-card" });
			const statusLine = card.createDiv({ cls: "yaos-settings-status-line" });
			const titleWrap = statusLine.createDiv({ cls: "yaos-settings-status-copy" });
			titleWrap.createEl("div", { text: "Connected to Host", cls: "yaos-settings-status-title" });
			titleWrap.createEl("div", {
				text: "Your vault is connected to its host server and syncing.",
				cls: "yaos-settings-status-subtitle",
			});
			statusLine.createSpan({
				text: syncStatus.label,
				cls: `yaos-settings-status-badge ${statusClass(syncStatus.state)}`,
			});

			addCardRow(card, "Host", this.plugin.settings.host);
			addCardRow(card, "Vault ID", shortenMiddle(this.plugin.settings.vaultId || "(not set)"));
			addCardRow(card, "Device", this.plugin.settings.deviceName || "(unnamed)");

			const connectedDevices = this.plugin.getConnectedDevices();
			const othersOnline = connectedDevices.filter((d) => !d.isLocal);
			const deviceRow = card.createDiv({ cls: "yaos-settings-card-row" });
			deviceRow.createSpan({ text: "Online devices", cls: "yaos-settings-card-label" });
			const deviceValueEl = deviceRow.createDiv({ cls: "yaos-settings-card-value" });
			if (othersOnline.length === 0) {
				deviceValueEl.setText("None");
			} else {
				for (const device of othersOnline) {
					deviceValueEl.createDiv({ text: device.name });
				}
			}

			const actionRow = card.createDiv({ cls: "modal-button-container yaos-settings-status-actions" });
			actionRow.createEl("button", { text: "Backup connection details" }).addEventListener("click", () => {
				const recoveryKit = this.plugin.buildRecoveryKitText();
				if (!recoveryKit) {
					new Notice("Configure the host URL, sync token, and vault ID before exporting connection details.", 7000);
					return;
				}
				new RecoveryKitModal(this.app, recoveryKit).open();
			});
			actionRow.createEl("button", { text: "Reset connection" }).addEventListener("click", () => {
				confirmAction(
					this.app,
					"Reset connection",
					"This clears your host URL, token, and vault ID from this device. Your server data is not deleted. You can use the setup link to reconnect.",
					async () => {
						this.plugin.settings.host = "";
						this.plugin.settings.token = "";
						this.plugin.settings.vaultId = "";
						this.plugin.settings.syncMode = "standalone";
						await this.plugin.saveSettings();
						this.display();
					},
				);
			});

			// Change connection (collapsed — for users who need to update host/token)
			const changeDetails = createDetailsSection(connectionBody, "Change connection", false);
			const changeBody = changeDetails.createDiv({ cls: "yaos-settings-details-body" });
			this.renderConnectionFields(changeBody, authMode);
		}

		// ── Section 2: Share your notes (Hub role) ────────────────────────────
		if (!setupIncomplete) {
			const hubDetails = createDetailsSection(containerEl, "Share your notes", isHub);
			const hubBody = hubDetails.createDiv({ cls: "yaos-settings-details-body" });

			if (!isHub) {
				hubBody.createEl("p", {
					text: "Share this vault's notes with other vaults. Connected vaults receive your shared content in real time.",
					cls: "setting-item-description",
				});
				hubBody
					.createDiv({ cls: "modal-button-container yaos-settings-status-actions" })
					.createEl("button", { text: "Start sharing", cls: "mod-cta" })
					.addEventListener("click", async () => {
						this.plugin.settings.syncMode = isSpoke ? "hub+spoke" : "hub";
						await this.plugin.saveSettings();
						this.display();
					});
			} else {
				// Hub active — show spoke list
				const spokesContainer = hubBody.createDiv();
				const renderSpokes = (spokes: SpokeInfo[]) => {
					spokesContainer.empty();
					if (spokes.length === 0) {
						spokesContainer.createEl("p", {
							text: "No vaults connected yet. Use the invite button to connect a vault.",
							cls: "setting-item-description",
						});
					} else {
						const spokeCard = spokesContainer.createDiv({ cls: "yaos-settings-status-card" });
						for (const spoke of spokes) {
							const spokeRow = spokeCard.createDiv({ cls: "yaos-settings-card-row" });
							spokeRow.createSpan({ text: spoke.deviceName, cls: "yaos-settings-card-label" });
							spokeRow.createSpan({
								text: `ID: ${shortenMiddle(spoke.spokeVaultId)} · Last seen: ${
									spoke.lastSeen ? new Date(spoke.lastSeen).toLocaleDateString() : "never"
								}`,
								cls: "yaos-settings-card-value",
							});
							const removeBtn = spokeRow.createEl("button", { text: "Remove" });
							removeBtn.addEventListener("click", () => {
								confirmAction(
									this.app,
									"Remove spoke vault",
									`Remove "${spoke.deviceName}"? The spoke vault will stop receiving hub content.`,
									async () => {
										removeBtn.disabled = true;
										removeBtn.textContent = "Removing…";
										try {
											await this.plugin.removeSpokeFromHub(spoke.spokeVaultId);
											void this.plugin.fetchHubSpokes().then(renderSpokes);
										} catch (err) {
											new Notice(`Failed to remove spoke: ${err instanceof Error ? err.message : String(err)}`, 6000);
											removeBtn.disabled = false;
											removeBtn.textContent = "Remove";
										}
									},
								);
							});
						}
					}
				};
				void this.plugin.fetchHubSpokes().then(renderSpokes);

				const hubActions = hubBody.createDiv({ cls: "modal-button-container yaos-settings-status-actions" });
				hubActions.createEl("button", { text: "Invite a vault" }).addEventListener("click", () => {
					const { host, vaultId, token } = this.plugin.settings;
					if (!host || !vaultId || !token) {
						new Notice("Configure the connection first.", 6000);
						return;
					}
					new SpokeInviteModal(this.app, host, vaultId, token).open();
				});
				hubActions.createEl("button", { text: "Refresh" }).addEventListener("click", () => {
					void this.plugin.fetchHubSpokes().then(renderSpokes);
				});
				hubActions.createEl("button", { text: "Stop sharing" }).addEventListener("click", () => {
					confirmAction(
						this.app,
						"Stop sharing",
						"This vault will stop sharing notes. Connected spokes will no longer receive updates.",
						async () => {
							this.plugin.settings.syncMode = isSpoke ? "spoke" : "standalone";
							await this.plugin.saveSettings();
							this.display();
						},
					);
				});
			}
		}

		// ── Section 3: Follow a Hub (Spoke role) ──────────────────────────────
		if (!setupIncomplete) {
			const followDetails = createDetailsSection(containerEl, "Follow a Hub", isSpoke);
			const followBody = followDetails.createDiv({ cls: "yaos-settings-details-body" });

			if (!isSpoke) {
				followBody.createEl("p", {
					text: "Receive shared notes from another vault. Connect using the hub vault's ID — the hub must be on the same host server.",
					cls: "setting-item-description",
				});
				new Setting(followBody)
					.setName("Hub vault ID")
					.setDesc("Get this from the hub vault's invite link.")
					.addText((text) =>
						text
							.setPlaceholder("Paste hub vault ID")
							.setValue(this.plugin.settings.spokeHubVaultId)
							.onChange(async (value) => {
								this.plugin.settings.spokeHubVaultId = value.trim();
								await this.plugin.saveSettings();
							}),
					);
				followBody
					.createDiv({ cls: "modal-button-container yaos-settings-status-actions" })
					.createEl("button", { text: "Connect to hub", cls: "mod-cta" })
					.addEventListener("click", async () => {
						const { spokeHubVaultId, host, token } = this.plugin.settings;
						if (!spokeHubVaultId) {
							new Notice("Enter the hub vault ID first.", 6000);
							return;
						}
						// Spoke connects to the same host — populate spoke fields from existing connection.
						this.plugin.settings.spokeHubHost = host;
						this.plugin.settings.spokeHubToken = token;
						if (!this.plugin.settings.vaultId) {
							this.plugin.settings.vaultId = generateVaultId();
							await this.plugin.saveSettings();
						}
						try {
							await this.plugin.registerWithHub();
							this.plugin.settings.syncMode = isHub ? "hub+spoke" : "spoke";
							await this.plugin.saveSettings();
							new Notice("Connected to hub vault. Hub content will appear shortly.");
							this.display();
							this.plugin.restartSync();
						} catch (err) {
							new Notice(`Registration failed: ${err instanceof Error ? err.message : String(err)}`, 8000);
						}
					});
			} else {
				// Spoke connected card
				const followCard = followBody.createDiv({ cls: "yaos-settings-status-card" });
				const followLine = followCard.createDiv({ cls: "yaos-settings-status-line" });
				const followTitleWrap = followLine.createDiv({ cls: "yaos-settings-status-copy" });
				followTitleWrap.createEl("div", { text: "Following a hub", cls: "yaos-settings-status-title" });
				followTitleWrap.createEl("div", {
					text: "This vault is receiving shared notes from a hub vault.",
					cls: "yaos-settings-status-subtitle",
				});
				followLine.createSpan({ text: "Connected", cls: "yaos-settings-status-badge is-connected" });

				addCardRow(followCard, "Hub vault", shortenMiddle(this.plugin.settings.spokeHubVaultId || "(not set)"));
				addCardRow(followCard, "Host", this.plugin.settings.spokeHubHost || this.plugin.settings.host);

				const followActions = followCard.createDiv({ cls: "modal-button-container yaos-settings-status-actions" });
				followActions.createEl("button", { text: "Re-register" }).addEventListener("click", async () => {
					try {
						await this.plugin.registerWithHub();
						new Notice("Re-registered with hub.");
						this.plugin.maybeStartSync();
					} catch (err) {
						new Notice(`Re-registration failed: ${err instanceof Error ? err.message : String(err)}`, 8000);
					}
				});
				followActions.createEl("button", { text: "Disconnect" }).addEventListener("click", async () => {
					try {
						await this.plugin.disconnectFromHub();
					} catch (err) {
						new Notice(`Disconnect failed: ${err instanceof Error ? err.message : String(err)}`, 6000);
						return;
					}
					this.display();
				});
			}
		}

		// ── Updates ───────────────────────────────────────────────────────────
		if (!setupIncomplete) {
			const updateState = this.plugin.getUpdateState();
			addSectionHeading(containerEl, "Updates");

			const updateCard = containerEl.createDiv({ cls: "yaos-settings-status-card" });
			addCardRow(updateCard, "Server version", updateState.serverVersion ?? "Unknown");
			addCardRow(updateCard, "Latest server", updateState.latestServerVersion ?? "Unknown");
			addCardRow(updateCard, "Plugin version", updateState.pluginVersion);
			if (updateState.updateRepoUrl) {
				addCardRow(updateCard, "Latest plugin", updateState.latestPluginVersion ?? "Unknown");
				addCardRow(updateCard, "Update path", updateState.updateRepoUrl);
			}

			const summaryText = updateState.serverUpdateAvailable
				? updateState.migrationRequired
					? "A migration-sensitive server update is available. Use the guided update path."
					: "A server update is available."
				: updateState.pluginUpdateRecommended
					? "This device should update the YAOS plugin soon."
					: "Server is up to date.";
			updateCard.createEl("p", { text: summaryText, cls: "yaos-settings-status-subtitle" });
			if (!updateState.updateRepoUrl) {
				updateCard.createEl("p", {
					text: "Set a deployment repo URL in Advanced to enable plugin update tracking.",
					cls: "yaos-settings-status-subtitle",
				});
			}

			if (updateState.pluginCompatibilityWarning) {
				updateCard.createEl("p", {
					text: updateState.pluginCompatibilityWarning,
					cls: "yaos-settings-security-warning",
				});
			}
			if (updateState.legacyServerDetected) {
				updateCard.createEl("p", {
					text: "Legacy server detected. Sync will continue, but update metadata and 1-click updater features need a newer server.",
					cls: "yaos-settings-security-warning",
				});
			}

			const updateActions = updateCard.createDiv({ cls: "modal-button-container yaos-settings-status-actions" });
			updateActions.createEl("button", { text: "Refresh update info" }).addEventListener("click", () => {
				void this.plugin.refreshServerCapabilities("settings-refresh");
				void this.plugin.refreshUpdateManifest("settings-refresh", true).then(() => this.display());
			});
			const updateActionUrl = updateState.updateActionUrl;
			if (updateActionUrl) {
				updateActions.createEl("button", { text: "Open update action" }).addEventListener("click", () => {
					window.open(updateActionUrl, "_blank", "noopener");
				});
			}
			const bootstrapUrl = updateState.updateBootstrapUrl;
			if (bootstrapUrl) {
				updateActions.createEl("button", { text: "Initialize updater" }).addEventListener("click", () => {
					window.open(bootstrapUrl, "_blank", "noopener");
				});
			}
		}

		// ── This device ───────────────────────────────────────────────────────
		addSectionHeading(containerEl, "This device");
		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Shown to other devices in live cursors and presence.")
			.addText((text) =>
				text
					.setPlaceholder("My laptop")
					.setValue(this.plugin.settings.deviceName)
					.onChange(async (value) => {
						this.plugin.settings.deviceName = value.trim();
						await this.plugin.saveSettings();
						this.plugin.updateAwarenessDeviceName(value.trim());
					}),
			);
		new Setting(containerEl)
			.setName("Show remote cursors")
			.setDesc("Show other devices' cursors and selections while editing.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showRemoteCursors)
					.onChange(async (value) => {
						this.plugin.settings.showRemoteCursors = value;
						await this.plugin.saveSettings();
						this.plugin.applyCursorVisibility();
					}),
			);

		// ── Sync filters ──────────────────────────────────────────────────────
		if (!isSpoke) {
			addSectionHeading(containerEl, "Sync filters");
			new Setting(containerEl)
				.setName("Folders to sync")
				.setDesc("Only sync files inside these folders. Separate multiple folders with commas. Leave empty to sync everything. Example: Projects/Shared/, Team Notes/")
				.addText((text) =>
					text
						.setPlaceholder("Example: Projects/Shared/, Team Notes/")
						.setValue(this.plugin.settings.includePaths)
						.onChange(async (value) => {
							this.plugin.settings.includePaths = value;
							await this.plugin.saveSettings();
							this.plugin.onSettingsChanged();
						}),
				)
				.addButton((btn) =>
					btn
						.setButtonText("Add folder")
						.onClick(() => {
							new FolderPickerModal(this.app, async (folder) => {
								this.plugin.settings.includePaths = appendFolderPath(
									this.plugin.settings.includePaths,
									folder.path,
								);
								await this.plugin.saveSettings();
								this.plugin.onSettingsChanged();
								this.display();
							}).open();
						}),
				);

			new Setting(containerEl)
				.setName("Excluded paths")
				.setDesc("Paths to skip, separated by commas. Example: templates/, .trash/, daily-notes/")
				.addText((text) =>
					text
						.setPlaceholder("Example: templates/, daily-notes/")
						.setValue(this.plugin.settings.excludePatterns)
						.onChange(async (value) => {
							this.plugin.settings.excludePatterns = value;
							await this.plugin.saveSettings();
							this.plugin.onSettingsChanged();
						}),
				)
				.addButton((btn) =>
					btn
						.setButtonText("Add folder")
						.onClick(() => {
							new FolderPickerModal(this.app, async (folder) => {
								this.plugin.settings.excludePatterns = appendFolderPath(
									this.plugin.settings.excludePatterns,
									folder.path,
								);
								await this.plugin.saveSettings();
								this.plugin.onSettingsChanged();
								this.display();
							}).open();
						}),
				);

			new Setting(containerEl)
				.setName("Max note size (KB)")
				.setDesc("Notes larger than this are skipped.")
				.addText((text) =>
					text
						.setPlaceholder("2048")
						.setValue(String(this.plugin.settings.maxFileSizeKB))
						.onChange(async (value) => {
							const n = parseInt(value, 10);
							if (!isNaN(n) && n > 0) {
								this.plugin.settings.maxFileSizeKB = n;
								await this.plugin.saveSettings();
								this.plugin.onSettingsChanged();
							}
						}),
				);
		}

		// ── Attachments ───────────────────────────────────────────────────────
		if (!setupIncomplete && !isSpoke) {
			addSectionHeading(containerEl, "Attachments");

			new Setting(containerEl)
				.setName("Attachment storage")
				.setDesc(
					attachmentsAvailable
						? "Available on this host. The plugin can sync attachments and snapshots."
						: "Not available on this host. Add object storage in Cloudflare, then redeploy.",
				)
				.addButton((button) =>
					button
						.setButtonText("Refresh")
						.onClick(async () => {
							button.setDisabled(true);
							await this.plugin.refreshServerCapabilities();
							await this.plugin.refreshAttachmentSyncRuntime("capability-refresh");
							this.display();
						}),
				);

			if (!attachmentsAvailable) {
				const noR2Note = containerEl.createDiv({ cls: "yaos-settings-attachment-callout" });
				const noR2Text = noR2Note.createEl("p", { cls: "yaos-settings-status-subtitle" });
				noR2Text.appendText("Attachment sync requires a Cloudflare R2 bucket — ");
				const setupLink = noR2Text.createEl("a", {
					text: "watch the 1-minute setup guide",
					href: "https://youtu.be/Z7xCMEYfdFM",
				});
				setupLink.setAttr("target", "_blank");
				noR2Text.appendText(".");
			}

			if (attachmentsAvailable) {
				new Setting(containerEl)
					.setName("Sync attachments")
					.setDesc("Sync images, PDF files, and other attachments through object storage. This is enabled by default when the host supports it.")
					.addToggle((toggle) =>
						toggle
							.setValue(this.plugin.settings.enableAttachmentSync)
							.onChange(async (value) => {
								this.plugin.settings.enableAttachmentSync = value;
								this.plugin.settings.attachmentSyncExplicitlyConfigured = true;
								await this.plugin.saveSettings();
								await this.plugin.refreshAttachmentSyncRuntime("attachment-toggle");
								this.display();
							}),
					);
			}

			if (attachmentsAvailable && this.plugin.settings.enableAttachmentSync) {
				new Setting(containerEl)
					.setName("Max attachment size (KB)")
					.setDesc("Attachments larger than this are skipped.")
					.addText((text) =>
						text
							.setPlaceholder("10240")
							.setValue(String(this.plugin.settings.maxAttachmentSizeKB))
							.onChange(async (value) => {
								const n = parseInt(value, 10);
								if (!isNaN(n) && n > 0) {
									this.plugin.settings.maxAttachmentSizeKB = n;
									await this.plugin.saveSettings();
								}
							}),
					);

				new Setting(containerEl)
					.setName("Upload/download slots")
					.setDesc("Simultaneous transfers. Default 1 is safest on mobile.")
					.addSlider((slider) =>
						slider
							.setLimits(1, 5, 1)
							.setValue(this.plugin.settings.attachmentConcurrency)
							.setDynamicTooltip()
							.onChange(async (value) => {
								this.plugin.settings.attachmentConcurrency = value;
								await this.plugin.saveSettings();
							}),
					);
			}
		}

		// ── Advanced ──────────────────────────────────────────────────────────
		const advancedDetails = createDetailsSection(containerEl, "Advanced", false);
		const advancedBody = advancedDetails.createDiv({ cls: "yaos-settings-details-body" });

		new Setting(advancedBody)
			.setName("Vault ID")
			.setDesc("Devices syncing the same vault must use exactly the same vault ID. Change only if you know what you are doing.")
			.addText((text) =>
				text
					.setPlaceholder("Generated automatically")
					.setValue(this.plugin.settings.vaultId)
					.onChange(async (value) => {
						this.plugin.settings.vaultId = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(advancedBody)
			.setName("Deployment repo URL")
			.setDesc("Optional. Example: https://github.com/you/yaos-server. Provider is inferred from this URL.")
			.addText((text) =>
				text
					.setPlaceholder("Paste the generated GitHub or GitLab repo URL")
					.setValue(this.plugin.settings.updateRepoUrl)
					.onChange(async (value) => {
						this.plugin.settings.updateRepoUrl = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(advancedBody)
			.setName("Deployment default branch")
			.setDesc("Used for GitLab pipeline links and future provider-native update helpers.")
			.addText((text) =>
				text
					.setPlaceholder("Default branch (for example, main)")
					.setValue(this.plugin.settings.updateRepoBranch)
					.onChange(async (value) => {
						this.plugin.settings.updateRepoBranch = value.trim() || "main";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(advancedBody)
			.setName("Edits from other apps")
			.setDesc("Choose how the plugin handles file changes from Git, scripts, or other editors.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("always", "Always import")
					.addOption("closed-only", "Only when file is closed")
					.addOption("never", "Never import")
					.setValue(this.plugin.settings.externalEditPolicy)
					.onChange(async (value) => {
						this.plugin.settings.externalEditPolicy = value as ExternalEditPolicy;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(advancedBody)
			.setName("Frontmatter safety guard")
			.setDesc("Pause suspicious YAML property updates before they spread. Disable only while troubleshooting valid frontmatter that is being blocked.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.frontmatterGuardEnabled)
					.onChange(async (value) => {
						this.plugin.settings.frontmatterGuardEnabled = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(advancedBody)
			.setName("Debug logging")
			.setDesc("Enable verbose console logs for troubleshooting.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debug)
					.onChange(async (value) => {
						this.plugin.settings.debug = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	private async maybeBootstrapConnection(): Promise<void> {
		const { host, token } = this.plugin.settings;
		if (!host || !token) return;
		if (!this.plugin.settings.vaultId) {
			this.plugin.settings.vaultId = generateVaultId();
			await this.plugin.saveSettings();
		}
		this.plugin.maybeStartSync();
	}

	private renderConnectionFields(containerEl: HTMLElement, authMode: string): void {
		new Setting(containerEl)
			.setName("Host URL")
			.setDesc("Your Cloudflare Worker URL. Usually filled in automatically by the setup link.")
			.addText((text) =>
				text
					.setPlaceholder("Paste the host URL")
					.setValue(this.plugin.settings.host)
					.onChange(async (value) => {
						this.plugin.settings.host = value.trim();
						await this.plugin.saveSettings();
						await this.maybeBootstrapConnection();
						this.display();
					}),
			);

		if (isInsecureRemoteHost(this.plugin.settings.host)) {
			containerEl.createEl("p", {
				text: "This remote connection is unencrypted. Your sync token will be sent in plaintext. Use HTTPS for production.",
				cls: "yaos-settings-security-warning",
			});
		}

		new Setting(containerEl)
			.setName("Sync token")
			.setDesc(
				authMode === "unclaimed"
					? "Leave this blank until you claim the server in a browser, then use the setup link."
					: authMode === "env"
						? "Must match the SYNC_TOKEN configured on the server."
						: "Usually filled in automatically by the setup link after you claim the server.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Paste your sync token")
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value.trim();
						await this.plugin.saveSettings();
						await this.maybeBootstrapConnection();
						this.display();
					}),
			);
	}
}
