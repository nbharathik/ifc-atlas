import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../useStore';

const store = () => useStore.getState();

function resetSlice() {
  useStore.setState({
    docIndexFiles: [],
    docIndexLoading: false,
  });
}

describe('document index store slice', () => {
  beforeEach(resetSlice);

  it('setDocIndexLoading toggles loading flag', () => {
    store().setDocIndexLoading(true);
    expect(store().docIndexLoading).toBe(true);
    store().setDocIndexLoading(false);
    expect(store().docIndexLoading).toBe(false);
  });

  it('setDocIndexFiles replaces list', () => {
    const files = [
      { doc_id: 'a', name: 'spec.md', chunk_count: 3, char_count: 500, uploaded_at: '2026-01-01T00:00:00Z', sha256: 'abc' },
    ];
    store().setDocIndexFiles(files);
    expect(store().docIndexFiles).toHaveLength(1);
    expect(store().docIndexFiles[0].doc_id).toBe('a');

    store().setDocIndexFiles([]);
    expect(store().docIndexFiles).toHaveLength(0);
  });

  it('addDocIndexFile prepends to list', () => {
    const first = { doc_id: 'a', name: 'first.md', chunk_count: 1, char_count: 100, uploaded_at: '2026-01-01T00:00:00Z', sha256: 'aaa' };
    const second = { doc_id: 'b', name: 'second.pdf', chunk_count: 5, char_count: 2000, uploaded_at: '2026-01-02T00:00:00Z', sha256: 'bbb' };
    store().addDocIndexFile(first);
    store().addDocIndexFile(second);
    expect(store().docIndexFiles[0].doc_id).toBe('b');
    expect(store().docIndexFiles[1].doc_id).toBe('a');
  });

  it('removeDocIndexFile removes by doc_id', () => {
    store().setDocIndexFiles([
      { doc_id: 'a', name: 'a.md', chunk_count: 1, char_count: 100, uploaded_at: '', sha256: '' },
      { doc_id: 'b', name: 'b.md', chunk_count: 2, char_count: 200, uploaded_at: '', sha256: '' },
    ]);
    store().removeDocIndexFile('a');
    const files = store().docIndexFiles;
    expect(files).toHaveLength(1);
    expect(files[0].doc_id).toBe('b');
  });

  it('removeDocIndexFile with unknown id is a no-op', () => {
    store().setDocIndexFiles([
      { doc_id: 'a', name: 'a.md', chunk_count: 1, char_count: 100, uploaded_at: '', sha256: '' },
    ]);
    store().removeDocIndexFile('nonexistent');
    expect(store().docIndexFiles).toHaveLength(1);
  });
});
