import type { CaptureRecord, ContentWatermark } from '../../core/types.js';
import type { FsLike } from '../../host/fs-adapter.js';

export function makeFsCaptureStore(fs: FsLike, baseDir: string) {
  return {
    async loadWatermark(): Promise<ContentWatermark | null> { return null; },
    async appendRecords(records: readonly CaptureRecord[], watermark: ContentWatermark): Promise<void> {
      const path = `${baseDir}/segment-000001.json`;
      let content = '';
      try { content = await fs.read(path); } catch {}
      if (records.length) content = records.map((record) => JSON.stringify(record)).join('\n');
      await fs.write(path, content);
      await fs.write(`${baseDir}/watermark.json`, JSON.stringify({ watermark }));
    },
  };
}
