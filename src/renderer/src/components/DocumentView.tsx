import { useEffect, useRef, useState } from 'react';
import { call, isDesktop } from '../api';
import { useApp } from '../state';
import { Button } from './ui';

/**
 * Renders a printable document (receipt / credit note / report) exactly as it
 * will be printed, with local printing and HTML export.
 */
export function DocumentView({
  html,
  filename,
  title
}: {
  html: string;
  filename: string;
  title: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const { notify } = useApp();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;
    if (frame) frame.srcdoc = html;
  }, [html]);

  async function print() {
    setBusy(true);
    try {
      if (isDesktop()) {
        const result = await call<{ printed: boolean; message: string }>('print.document', { html, title });
        notify(result.message, result.printed ? 'success' : 'info');
      } else {
        frameRef.current?.contentWindow?.focus();
        frameRef.current?.contentWindow?.print();
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Printing failed.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      if (isDesktop()) {
        const result = await call<{ path: string }>('documents.saveHtml', { html, filename });
        notify(`Saved to ${result.path}`, 'success');
      } else {
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename.endsWith('.html') ? filename : `${filename}.html`;
        link.click();
        URL.revokeObjectURL(url);
        notify('Document downloaded.', 'success');
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not save the document.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <iframe ref={frameRef} className="doc-preview" title={title} />
      <div className="doc-actions">
        <Button onClick={print} disabled={busy}>
          Print
        </Button>
        <Button variant="ghost" onClick={save} disabled={busy}>
          Save HTML
        </Button>
      </div>
    </div>
  );
}
