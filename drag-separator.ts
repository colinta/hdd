import {
  Point,
  Size,
  View,
  type MouseEvent,
  type ViewProps,
  type Viewport,
} from '@teaui/core';
import {registerElement} from '@teaui/react';
import React from 'react';

export interface DragSeparatorProps extends ViewProps {
  /** Called when a drag begins. */
  onDragStart?(): void;
  /**
   * Called while dragging with the number of rows the mouse has moved since the drag began
   * (positive is down).
   */
  onDrag(rows: number): void;
  /** Called when the drag ends, whether released inside the separator or not. */
  onDragEnd?(): void;
}

/**
 * A horizontal divider that can be dragged up and down. It does not move on its own;
 * `onDrag` reports the distance so the owner can relayout.
 */
export class DragSeparator extends View {
  #onDragStart: DragSeparatorProps['onDragStart'];
  #onDrag: DragSeparatorProps['onDrag'];
  #onDragEnd: DragSeparatorProps['onDragEnd'];
  #isDragging = false;

  constructor(props: DragSeparatorProps) {
    super(props);
    this.#onDragStart = props.onDragStart;
    this.#onDrag = props.onDrag;
    this.#onDragEnd = props.onDragEnd;
  }

  update(props: DragSeparatorProps): void {
    const {onDragStart, onDrag, onDragEnd, ...viewProps} = props;
    this.#onDragStart = onDragStart;
    this.#onDrag = onDrag;
    this.#onDragEnd = onDragEnd;
    super.update(viewProps);
  }

  naturalSize(available: Size): Size {
    return new Size(available.width, 1);
  }

  receiveMouse(event: MouseEvent, system: Parameters<View['receiveMouse']>[1]): void {
    super.receiveMouse(event, system);

    // Positions are relative to where the separator was when the drag began, even after
    // the separator has since moved, so `position.y` is the distance dragged.
    switch (event.name) {
      case 'mouse.button.down':
        this.#isDragging = true;
        this.#onDragStart?.();
        break;
      case 'mouse.button.dragInside':
      case 'mouse.button.dragOutside':
      case 'mouse.button.enter':
      case 'mouse.button.exit':
        if (this.#isDragging) {
          this.#onDrag(event.position.y);
        }
        break;
      case 'mouse.button.up':
      case 'mouse.button.cancel':
        if (this.#isDragging) {
          this.#isDragging = false;
          this.#onDrag(event.position.y);
          this.#onDragEnd?.();
        }
        break;
    }
    this.invalidateRender();
  }

  render(viewport: Viewport): void {
    if (viewport.isEmpty) {
      return;
    }

    viewport.registerMouse(['mouse.move', 'mouse.button.left']);
    const isActive = this.#isDragging || this.isHover;
    const char = isActive ? '━' : '─';
    const style = this.purpose.text();
    const rect = viewport.visibleRect;
    viewport.write(char.repeat(rect.size.width), new Point(rect.origin.x, 0), style);
  }
}

registerElement('hdd-drag-separator', (props: DragSeparatorProps) => new DragSeparator(props));

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'hdd-drag-separator': DragSeparatorProps & {key?: React.Key};
    }
  }
}

export function DragDivider(props: DragSeparatorProps): JSX.Element {
  return React.createElement('hdd-drag-separator', props);
}
