import type { ReactElement } from "react";
import { type SettingsFooterProps } from "./settingsTypes";

export function SettingsFooter({ saveMessage, onSave }: SettingsFooterProps): ReactElement {
  return (
    <footer className="settings-footer">
      <button className="btn btn-primary" onClick={() => void onSave()} type="button">
        保存设置
      </button>
      {saveMessage && <span className="save-feedback">{saveMessage}</span>}
    </footer>
  );
}
