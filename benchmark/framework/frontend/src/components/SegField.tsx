interface Props {
  options: string[];
  // Omit to render each option verbatim; supply only for translated labels.
  labels?: Record<string, string>;
  // value / onChange are injected by antd Form.Item (cloneElement). Keeping this a
  // controlled component is what preserves prefill / reuse-config + required validation.
  value?: string;
  onChange?: (v: string) => void;
}

// Hand-written segmented control usable as a Form.Item child.
export default function SegField({ options, labels, value, onChange }: Props) {
  return (
    <div className={`seg${options.length > 3 ? " dense" : ""}`}>
      {options.map((o) => (
        <button
          type="button"
          key={o}
          className={o === value ? "on" : ""}
          onClick={() => onChange?.(o)}
        >
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}
