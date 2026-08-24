export async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const fallback = document.createElement("textarea");
  fallback.value = text;
  fallback.setAttribute("readonly", "");
  fallback.style.position = "fixed";
  fallback.style.left = "-9999px";
  document.body.appendChild(fallback);
  fallback.select();
  try {
    if (!document.execCommand("copy")) throw new Error("A cópia não foi autorizada");
  } finally {
    fallback.remove();
  }
}

export async function readClipboardText(): Promise<string> {
  if (!navigator.clipboard?.readText) {
    throw new Error("A leitura da área de transferência não está disponível");
  }
  return navigator.clipboard.readText();
}
