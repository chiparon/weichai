import * as vscode from 'vscode';

export const modelApiKeySecret = 'forexplore.modelApiKey';

export async function requireModelApiKey(context: vscode.ExtensionContext): Promise<string> {
  const existing = (await context.secrets.get(modelApiKeySecret))?.trim();
  if (existing) return existing;
  const entered = await vscode.window.showInputBox({
    title: '配置 ForeXplore 模型密钥',
    prompt: '密钥只存入 VS Code SecretStorage，不会写入设置、Webview 或日志。',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : '模型密钥不能为空。',
  });
  if (!entered?.trim()) throw new Error('未配置模型密钥，翻译已取消。');
  await context.secrets.store(modelApiKeySecret, entered.trim());
  return entered.trim();
}

export async function configureModelApiKey(context: vscode.ExtensionContext): Promise<void> {
  const entered = await vscode.window.showInputBox({
    title: '更新 ForeXplore 模型密钥',
    prompt: '新值将替换 SecretStorage 中的现有密钥。',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : '模型密钥不能为空。',
  });
  if (!entered?.trim()) return;
  await context.secrets.store(modelApiKeySecret, entered.trim());
  void vscode.window.showInformationMessage('ForeXplore 模型密钥已更新。');
}
