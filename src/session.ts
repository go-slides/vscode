// A talk's panels and what passes between them, with nothing from VS Code in it
// (a panel is whatever implements Panel), so that the relay runs in a plain Node
// test as well.
//
// The panels of one deck (the slides, the overview, the presenter view) follow one
// another: a position one of them reports is the position of the others. The
// extension host is the relay, and relays nothing but a position (panel.ts has the
// shapes), as the playground's page does between its preview and its presenter
// window.
import type { FromShell, PanelKind, Sync } from './panel';

/** One panel of a talk, as the session sees it. */
export interface Panel {
  /** Tells the panel's page where the talk is. */
  sync(at: Sync): void;
  /** Brings the panel forward. */
  reveal(): void;
  /** Sends the panel's page (what the host last built) to it. */
  show(): void;
  /** Closes the panel. */
  close(): void;
}

/** What a session asks of the host: panels to open, the editor to move. */
export interface Host {
  /** Opens (or finds) the panel of a kind for this talk and returns it. */
  open(kind: PanelKind): Panel;
  /** Shows the source of slide index, as the overview's choice. */
  revealSource(index: number): void;
}

export class Session {
  /** Where the talk is, once any page has said. */
  last: Sync | undefined;
  private readonly panels = new Map<PanelKind, Panel>();

  constructor(private readonly host: Host) {}

  /** The panel of a kind, if open. */
  get(kind: PanelKind): Panel | undefined {
    return this.panels.get(kind);
  }

  get size(): number {
    return this.panels.size;
  }

  /** Opens the panel of a kind, or brings the open one forward. */
  open(kind: PanelKind): Panel {
    const open = this.panels.get(kind);
    if (open) {
      open.reveal();
      return open;
    }
    const panel = this.host.open(kind);
    this.panels.set(kind, panel);
    return panel;
  }

  /** The panel of a kind was closed (by its user, or by us). */
  closed(kind: PanelKind): void {
    this.panels.delete(kind);
  }

  /** Closes every panel; the talk is over. */
  end(): void {
    for (const p of [...this.panels.values()]) {
      p.close();
    }
    this.panels.clear();
  }

  /** What a panel's page said. */
  receive(from: PanelKind, m: FromShell): void {
    switch (m.type) {
      case 'ready':
        // a page that has just loaded is shown where the talk is
        this.panels.get(from)?.show();
        if (this.last) {
          this.panels.get(from)?.sync(this.last);
        }
        break;
      case 'sync':
        this.last = m.data;
        for (const [kind, panel] of this.panels) {
          if (kind !== from) {
            panel.sync(m.data);
          }
        }
        if (from === 'overview') {
          this.host.revealSource(m.data.index);
        }
        break;
      case 'present':
        // the slides page asked (the p key, its controller's button)
        if (from === 'slides') {
          this.open('presenter');
        }
        break;
      case 'close':
        if (from === 'overview') {
          this.panels.get(from)?.close();
        }
        break;
    }
  }
}
