// Minimal ambient types for the File System Access API bits we use that may
// be missing from the current lib.dom.d.ts.

interface DirectoryPickerOptions {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: FileSystemHandle | string;
}

interface Window {
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
}

interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
}
