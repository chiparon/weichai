// ArkTS / ArkUI fixture.
//
// Why this exists: the language registry already lists `arkts` (`.ets`) at the same
// `structural` capability level as Java, and cross-language-bindings.ts already has
// ArkTS handling, but no `.ets` file had ever been scanned — fixtures/code-corpus
// covered only Rust, Go, Java, C#, Python and TypeScript. So ArkTS support was
// registered, untested and unmeasured.
//
// The constructs below are the ones the registry comment flags as diagnostic:
// ArkUI decorators (@Entry/@Component/@State/@Prop/@Link/@Builder), struct-based
// components, and a native binding declared the way HarmonyOS does it. If the
// extractor reports them as unresolved or as diagnostics rather than as structure,
// that is the gap this fixture is meant to expose.

import nativeBridge from 'libentry.so';
import { BusinessError } from '@kit.BasicServicesKit';

@Entry
@Component
struct UploadPage {
  @State progress: number = 0;
  @Prop fileName: string = '';
  @Link session: UploadSession;

  private bridge: UploadBridge = new UploadBridge();

  aboutToAppear(): void {
    this.session.reset();
  }

  build(): void {
    Column() {
      Text(this.fileName).fontSize(16);
      Progress({ value: this.progress, total: 100 });
      Button('上传').onClick(() => { this.startUpload(); });
    }
  }

  private startUpload(): void {
    this.bridge.transfer(this.fileName, (sent: number, total: number) => {
      this.progress = Math.floor((sent * 100) / total);
    });
  }
}

/** Wraps the native module so pages never touch the raw binding. */
class UploadBridge {
  private readonly native = nativeBridge;

  transfer(fileName: string, onProgress: (sent: number, total: number) => void): void {
    const handle = this.native.beginUpload(fileName);
    if (handle < 0) throw new Error(`native upload rejected: ${handle}`);
    try {
      this.native.pumpChunks(handle, onProgress);
    } finally {
      this.native.endUpload(handle);
    }
  }

  abort(handle: number): void {
    try {
      this.native.endUpload(handle);
    } catch (error) {
      const failure = error as BusinessError;
      console.error(`abort failed: ${failure.code} ${failure.message}`);
    }
  }
}

interface UploadSession {
  reset(): void;
  readonly token: string;
}

export { UploadBridge, UploadPage };
