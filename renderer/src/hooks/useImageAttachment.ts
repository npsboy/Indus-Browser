import { useRef, useState } from "react";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB, keeps base64 payloads reasonable

export type PendingImage = {
  name: string;
  dataUrl: string;
};

export function useImageAttachment() {
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function pick() {
    inputRef.current?.click();
  }

  function clear() {
    setPendingImage(null);
    setError(null);
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  function readImageFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setError("Only images are supported right now.");
      return;
    }

    if (file.size > MAX_IMAGE_BYTES) {
      setError("Image is too large (max 8MB).");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setPendingImage({ name: file.name || "pasted-image.png", dataUrl: reader.result });
        setError(null);
      }
    };
    reader.onerror = () => {
      setError("Couldn't read that image.");
    };
    reader.readAsDataURL(file);
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    readImageFile(file);
  }

  function handlePaste(event: React.ClipboardEvent) {
    const items = event.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          readImageFile(file);
        }
        return;
      }
    }
  }

  function handleDrop(event: React.DragEvent) {
    const file = Array.from(event.dataTransfer?.files ?? []).find((f) => f.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    readImageFile(file);
  }

  const fileInputProps = {
    ref: inputRef,
    type: "file" as const,
    accept: "image/*",
    style: { display: "none" },
    onChange: handleFileChange,
  };

  return { pendingImage, error, pick, clear, handlePaste, handleDrop, fileInputProps };
}
