import { Annotation, StateEffect, Transaction, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import type { SyncClient } from '@collabpad/client';
import { deltasToChangeSet, localChangesToOps } from './changes';

/** Marks transactions that came from the network, so they are not echoed back as local ops. */
const remote = Annotation.define<boolean>();
/** Nudges the plugin to redraw remote cursors after a presence update. */
const presenceChanged = StateEffect.define<null>();

export interface Identity {
  name: string;
  color: string;
}

const PRESENCE_THROTTLE_MS = 50;

/**
 * A peer's caret with a name label. The label fades out after a moment (CSS) and comes back on
 * hover. `activity` changes whenever the peer moves or types, which forces a fresh DOM node and
 * so restarts the fade; plain re-renders keep the existing node.
 */
class CaretWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly color: string,
    readonly activity: number,
  ) {
    super();
  }

  override eq(other: CaretWidget): boolean {
    return (
      other.name === this.name && other.color === this.color && other.activity === this.activity
    );
  }

  toDOM(): HTMLElement {
    const caret = document.createElement('span');
    caret.className = 'cp-remote-caret';
    caret.style.borderColor = this.color;
    const label = document.createElement('span');
    label.className = 'cp-remote-label';
    label.style.backgroundColor = this.color;
    label.textContent = this.name;
    caret.appendChild(label);
    return caret;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Binds an EditorView to a SyncClient:
 *  - local transactions → CRDT ops → relay
 *  - remote ops → CRDT deltas → one CodeMirror transaction (kept out of undo history)
 *  - our selection → presence (CRDT anchors, throttled); peers' presence → caret decorations
 */
export function collab(client: SyncClient, identity: () => Identity): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private readonly off: (() => void)[];
      private readonly activity = new Map<string, number>();
      private presenceTimer: ReturnType<typeof setTimeout> | undefined;

      constructor(private readonly view: EditorView) {
        this.off = [
          client.on('remote', (_ops, deltas) => {
            if (deltas.length === 0) return;
            view.dispatch({
              changes: deltasToChangeSet(deltas, view.state.doc.length),
              annotations: [remote.of(true), Transaction.addToHistory.of(false)],
            });
          }),
          client.on('presence', (replica) => {
            this.activity.set(replica, (this.activity.get(replica) ?? 0) + 1);
            view.dispatch({ effects: presenceChanged.of(null) });
          }),
          client.on('status', (s) => s === 'online' && this.schedulePresence()),
        ];
        this.decorations = this.buildCarets();
        this.schedulePresence();
      }

      update(u: ViewUpdate): void {
        for (const tr of u.transactions) {
          if (tr.docChanged && !tr.annotation(remote)) {
            client.submit(localChangesToOps(client.doc, tr.changes));
          }
        }
        const presence = u.transactions.some((tr) => tr.effects.some((e) => e.is(presenceChanged)));
        if (u.docChanged || presence) this.decorations = this.buildCarets();
        if (u.selectionSet || u.docChanged) this.schedulePresence();
      }

      destroy(): void {
        this.off.forEach((fn) => fn());
        clearTimeout(this.presenceTimer);
      }

      private schedulePresence(): void {
        if (this.presenceTimer !== undefined) return;
        this.presenceTimer = setTimeout(() => {
          this.presenceTimer = undefined;
          const { anchor, head } = this.view.state.selection.main;
          client.setPresence({
            ...identity(),
            anchor: client.doc.anchorAt(anchor),
            head: client.doc.anchorAt(head),
          });
        }, PRESENCE_THROTTLE_MS);
      }

      private buildCarets(): DecorationSet {
        const len = this.view.state.doc.length;
        const ranges = [];
        for (const [replica, p] of client.peerPresence) {
          const anchor = Math.min(len, client.doc.resolveAnchor(p.anchor));
          const head = Math.min(len, client.doc.resolveAnchor(p.head));
          if (anchor !== head) {
            ranges.push(
              Decoration.mark({
                class: 'cp-remote-selection',
                attributes: { style: `background-color: ${p.color}33` },
              }).range(Math.min(anchor, head), Math.max(anchor, head)),
            );
          }
          const widget = new CaretWidget(p.name, p.color, this.activity.get(replica) ?? 0);
          ranges.push(Decoration.widget({ widget, side: 1 }).range(head));
        }
        return Decoration.set(ranges, true);
      }
    },
    { decorations: (v) => v.decorations },
  );

  return [
    plugin,
    EditorView.baseTheme({
      '.cp-remote-caret': {
        position: 'relative',
        borderLeft: '2px solid',
        marginLeft: '-1px',
        marginRight: '-1px',
      },
      '.cp-remote-label': {
        position: 'absolute',
        top: '-1.35em',
        left: '-2px',
        fontSize: '11px',
        lineHeight: '1.3',
        padding: '0 4px',
        borderRadius: '3px 3px 3px 0',
        color: '#fff',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        userSelect: 'none',
        animation: 'cp-label-fade 0.4s ease 2.5s forwards',
      },
      '.cp-remote-caret:hover .cp-remote-label': { animation: 'none', opacity: '1' },
      // Wider invisible hit area so the thin caret is hoverable.
      '.cp-remote-caret::after': {
        content: '""',
        position: 'absolute',
        inset: '0 -4px',
      },
      '@keyframes cp-label-fade': { to: { opacity: '0' } },
    }),
  ];
}
