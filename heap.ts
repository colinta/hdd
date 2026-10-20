/** A binary heap. `before(a, b)` is true when `a` should be popped before `b`. */
export class Heap<T> {
  private readonly items: T[] = [];
  private readonly before: (a: T, b: T) => boolean;

  constructor(before: (a: T, b: T) => boolean) {
    this.before = before;
  }

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    const items = this.items;
    let index = items.length;
    items.push(item);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.before(item, items[parent])) {
        break;
      }
      items[index] = items[parent];
      index = parent;
    }
    items[index] = item;
  }

  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length === 0 || last === undefined) {
      return top;
    }
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= items.length) {
        break;
      }
      const right = left + 1;
      const child =
        right < items.length && this.before(items[right], items[left]) ? right : left;
      if (!this.before(items[child], last)) {
        break;
      }
      items[index] = items[child];
      index = child;
    }
    items[index] = last;
    return top;
  }
}
