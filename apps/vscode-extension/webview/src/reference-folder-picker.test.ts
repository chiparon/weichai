import { expect, it, vi } from 'vitest';
import type { HostToWebviewMessage } from '../../src/protocol/messages';
import { browseReferenceFolders, mergeReferencePaths } from './reference-folder-picker';

it('correlates folder picker results, ignores unrelated responses, and cleans up on cancellation', async () => {
  let receive: (message: HostToWebviewMessage) => void = () => {};
  const unsubscribe = vi.fn();
  const post = vi.fn();
  const result = browseReferenceFolders({ post, subscribe: handler => { receive = handler; return unsubscribe; } });
  const request = post.mock.calls[0]![0];
  receive({ type: 'REFERENCE_FOLDERS_SELECTED', requestId: 'unrelated', paths: ['D:/wrong'] });
  expect(unsubscribe).not.toHaveBeenCalled();
  receive({ type: 'REFERENCE_FOLDERS_SELECTED', requestId: request.requestId, paths: [] });
  expect(await result).toEqual([]);
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it('merges selected paths into the draft without duplicating Windows slash/case variants', () => {
  expect(mergeReferencePaths([' D:\\Legacy ', '/home/Project'], ['d:/legacy/', 'D:/New', '/home/project']))
    .toEqual(['D:\\Legacy', '/home/Project', 'D:/New', '/home/project']);
});
