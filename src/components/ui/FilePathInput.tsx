import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { TextInput } from "./fields";
import Button from "./Button";

/** Mirrors FilePathInput.qml: text field plus a native file picker. */
export default function FilePathInput({
  path,
  placeholder,
  filters,
  onChange,
}: {
  path: string;
  placeholder?: string;
  filters: { name: string; extensions: string[] }[];
  onChange: (path: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex gap-1">
      <TextInput
        value={path}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button
        onClick={async () => {
          setBusy(true);
          try {
            const selected = await open({ multiple: false, filters });
            if (typeof selected === "string") onChange(selected);
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy}
      >
        …
      </Button>
    </div>
  );
}
