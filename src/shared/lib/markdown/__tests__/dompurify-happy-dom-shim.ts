// Test-only shim, registered via vitest setupFiles (vite.config.ts) so it runs
// before any test module loads DOMPurify; it is a no-op outside happy-dom. It
// makes tests running under happy-dom exercise the real sanitizer with
// browser semantics. It patches two happy-dom deviations DOMPurify depends on:
//
// 1. DOMPurify reads node names through the getter on Node.prototype (as a
//    clobbering defence). Browsers implement nodeName once on Node.prototype,
//    but happy-dom's base getter always returns "" and subclasses override it,
//    so every element would look unnamed and be dropped. The base getter is
//    made to delegate to the most specific override.
// 2. DOMPurify removes nodes while walking a NodeIterator and expects the
//    iterator to follow the DOM spec's removal steps (continue after the
//    removed node's predecessor, which visits content kept in its place).
//    happy-dom's iterator ignores removals and skips nodes, so
//    createNodeIterator is replaced with one that follows the spec.

const isHappyDom = typeof navigator !== "undefined" && navigator.userAgent.includes("HappyDOM");

function patchNodeName(): void {
  const base = Object.getOwnPropertyDescriptor(Node.prototype, "nodeName");
  if (!base?.get || !base.configurable) return;
  const baseGet = base.get;
  Object.defineProperty(Node.prototype, "nodeName", {
    configurable: true,
    enumerable: base.enumerable,
    get(this: Node): string {
      let proto: object | null = Object.getPrototypeOf(this);
      while (proto && proto !== Node.prototype) {
        const own = Object.getOwnPropertyDescriptor(proto, "nodeName");
        if (own?.get) return own.get.call(this) as string;
        proto = Object.getPrototypeOf(proto);
      }
      return baseGet.call(this) as string;
    },
  });
}

class SpecNodeIterator {
  readonly root: Node;
  readonly whatToShow: number;
  readonly filter: NodeFilter | null;
  private reference: Node | null = null;
  private referenceParent: Node | null = null;
  private referencePrevious: Node | null = null;

  constructor(root: Node, whatToShow = 0xffffffff, filter: NodeFilter | null = null) {
    this.root = root;
    this.whatToShow = whatToShow;
    this.filter = filter;
  }

  nextNode(): Node | null {
    let candidate = this.start();
    while (candidate) {
      if (this.accepts(candidate)) {
        this.reference = candidate;
        this.referenceParent = candidate.parentNode;
        this.referencePrevious = candidate.previousSibling;
        return candidate;
      }
      candidate = this.following(candidate);
    }
    return null;
  }

  previousNode(): Node | null {
    throw new Error("previousNode is not supported by the test shim");
  }

  detach(): void {}

  // Where to resume, applying the spec's removal steps when the last
  // returned node has been removed from the iterated tree since.
  private start(): Node | null {
    if (!this.reference) return this.root;
    if (this.inTree(this.reference)) return this.following(this.reference);
    if (this.referencePrevious && this.inTree(this.referencePrevious)) {
      return this.afterSubtree(this.referencePrevious);
    }
    if (this.referenceParent && this.inTree(this.referenceParent)) {
      return this.referenceParent.firstChild ?? this.afterSubtree(this.referenceParent);
    }
    return null;
  }

  private inTree(node: Node): boolean {
    return node === this.root || this.root.contains(node);
  }

  private following(node: Node): Node | null {
    return node.firstChild ?? this.afterSubtree(node);
  }

  private afterSubtree(node: Node): Node | null {
    let current: Node | null = node;
    while (current && current !== this.root) {
      if (current.nextSibling) return current.nextSibling;
      current = current.parentNode;
    }
    return null;
  }

  private accepts(node: Node): boolean {
    if (!((1 << (node.nodeType - 1)) & this.whatToShow)) return false;
    if (!this.filter) return true;
    const result = typeof this.filter === "function" ? this.filter(node) : this.filter.acceptNode(node);
    return result === NodeFilter.FILTER_ACCEPT;
  }
}

function patchNodeIterator(): void {
  // Patch the prototype that actually owns the method; happy-dom exposes
  // per-window subclasses whose prototypes do not own it.
  let owner: object | null = Object.getPrototypeOf(document);
  while (owner && !Object.prototype.hasOwnProperty.call(owner, "createNodeIterator")) {
    owner = Object.getPrototypeOf(owner);
  }
  if (!owner) return;
  (owner as Document).createNodeIterator = function createNodeIterator(
    root: Node,
    whatToShow?: number,
    filter?: NodeFilter | null,
  ): NodeIterator {
    return new SpecNodeIterator(root, whatToShow, filter ?? null) as unknown as NodeIterator;
  };
}

if (isHappyDom) {
  patchNodeName();
  patchNodeIterator();
}

export {};
