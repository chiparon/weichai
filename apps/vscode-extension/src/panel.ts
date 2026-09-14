import * as vscode from 'vscode';
import type {
  HostToWebviewMessage,
  PanelInitPayload,
} from './protocol/messages';
import { isWebviewToHostMessage, webviewMessageRejectionReason, type WebviewToHostMessage } from './protocol/messages';

/** Handlers invoked when the Webview posts a message to the host. */
export interface PanelHandlers {
  onMessage(message: WebviewToHostMessage): void;
  /**
   * A refused payload. Without this the message simply vanished: a panel could
   * wait forever for an answer the host never knew it owed.
   */
  onInvalidMessage?(message: unknown, reason: string): void;
}

export const workbenchViewType = 'forexplore.translation';
const PANEL_TITLE = 'RECAST 智能开发工作台';

/**
 * Owns the translation Webview panel: creation, focus reuse, HTML injection
 * and postMessage delivery.
 */
export class TranslationPanel {
  public static current: TranslationPanel | undefined;

  private payload: PanelInitPayload;
  private handlers: PanelHandlers;

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    payload: PanelInitPayload,
    handlers: PanelHandlers,
  ) {
    this.payload = payload;
    this.handlers = handlers;
  }

  static async createOrShow(
    context: vscode.ExtensionContext,
    payload: PanelInitPayload,
    handlers: PanelHandlers,
  ): Promise<TranslationPanel> {
    if (TranslationPanel.current) {
      TranslationPanel.current.payload = payload;
      TranslationPanel.current.handlers = handlers;
      TranslationPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      TranslationPanel.current.post({ type: 'INIT', payload });
      return TranslationPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      workbenchViewType,
      PANEL_TITLE,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      },
    );
    return TranslationPanel.attach(panel, context, payload, handlers);
  }

  /**
   * Revives the panel VS Code hands back after a window reload or an extension
   * host restart. The previous Webview is gone, so scripts and resource roots
   * have to be granted again before the workbench can load.
   */
  static async restore(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    payload: PanelInitPayload,
    handlers: PanelHandlers,
  ): Promise<TranslationPanel> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    };
    return TranslationPanel.attach(panel, context, payload, handlers);
  }

  /** Takes ownership of a panel this class will drive from now on. */
  private static async attach(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    payload: PanelInitPayload,
    handlers: PanelHandlers,
  ): Promise<TranslationPanel> {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'recast-logo.svg');

    const instance = new TranslationPanel(panel, context, payload, handlers);
    TranslationPanel.current = instance;
    // The Webview is not ready to receive messages until its scripts are
    // loaded, so hold the INIT payload until it announces itself with READY.
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!isWebviewToHostMessage(message)) {
        instance.handlers.onInvalidMessage?.(message, webviewMessageRejectionReason(message));
        return;
      }
      if (message.type === 'READY') {
        instance.post({ type: 'INIT', payload: instance.payload });
      }
      instance.handlers.onMessage(message);
    });
    panel.onDidDispose(() => {
      void vscode.commands.executeCommand('setContext', 'forexplore.settingsOpen', false);
      if (TranslationPanel.current === instance) TranslationPanel.current = undefined;
    });
    panel.webview.html = await buildHtml(panel.webview, context.extensionUri);
    return instance;
  }

  post(message: HostToWebviewMessage): void {
    if (message.type === 'SERVICE_STATUS') this.payload.serviceStatus = message.status;
    if (message.type === 'REPOSITORY_STATUS') this.payload.repositoryStatuses = message.statuses;
    if (message.type === 'MODULE_EXPLORER') this.payload.moduleExplorer = message.explorer;
    if (message.type === 'CODE_INTELLIGENCE_STATUS') this.payload.codeIntelligence = message.presentation;
    if (message.type === 'SETTINGS_UPDATED') this.payload.settings = message.settings;
    if (message.type === 'TARGET_SELECTED') this.payload.target = message.target;
    if (message.type === 'TARGET_CLEARED') this.payload.target = null;
    void this.panel.webview.postMessage(message);
  }

  dispose(): void {
    this.panel.dispose();
  }
}

export async function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const indexPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'index.html');
  const bytes = await vscode.workspace.fs.readFile(indexPath);
  let html = Buffer.from(bytes).toString('utf8');
  const assetRoot = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview'));
  html = html.replaceAll('src="./', `src="${assetRoot.toString()}/`).replaceAll('href="./', `href="${assetRoot.toString()}/`);
  html = html.replaceAll('{{CSP_SOURCE}}', webview.cspSource);
  return html;
}
