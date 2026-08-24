type DirectoryDialogOptions = Readonly<{
  title: string;
  directory: true;
  multiple: false;
}>;

export type DirectoryPicker = (options: DirectoryDialogOptions) => Promise<string | null>;

type RepositoryDirectorySelection = {
  picker?: DirectoryPicker;
  onChoosingChange: (choosing: boolean) => void;
  onPathSelected: (path: string) => void;
  onError: (error: string | null) => void;
};

const DIRECTORY_DIALOG_OPTIONS: DirectoryDialogOptions = {
  title: "选择本地 Git 仓库文件夹",
  directory: true,
  multiple: false,
};

export async function chooseRepositoryDirectory({
  picker,
  onChoosingChange,
  onPathSelected,
  onError,
}: RepositoryDirectorySelection): Promise<void> {
  onChoosingChange(true);
  onError(null);
  try {
    const selected = picker
      ? await picker(DIRECTORY_DIALOG_OPTIONS)
      : await (await import("@tauri-apps/plugin-dialog")).open(DIRECTORY_DIALOG_OPTIONS);
    if (selected !== null) {
      onPathSelected(selected);
    }
  } catch {
    onError("选择文件夹失败，请确认 Balance 有权访问本机文件后重试");
  } finally {
    onChoosingChange(false);
  }
}
