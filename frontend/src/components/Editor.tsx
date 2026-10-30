import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view';
import type { SyncClient } from '@collabpad/client';
import { useEffect, useRef } from 'react';
import { collab, type Identity } from '../collab/plugin';

export function Editor({ client, identity }: { client: SyncClient; identity: Identity }) {
  const host = useRef<HTMLDivElement>(null);
  const identityRef = useRef(identity);
  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);

  useEffect(() => {
    // Read the CRDT text and subscribe in the same tick, so no remote op slips in between.
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: client.doc.text(),
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          placeholder('Start typing… everyone with the link sees it live.'),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          collab(client, () => identityRef.current),
        ],
      }),
    });
    view.focus();
    // Debug handle (also used by the E2E tests, including against production builds). It only
    // exposes this page's own client to this page's own scripts.
    Object.assign(window, {
      __collabpad: {
        client,
        editorText: () => view.state.doc.toString(),
        text: () => client.doc.text(),
      },
    });
    return () => view.destroy();
  }, [client]);

  return <div className="editor" ref={host} />;
}
