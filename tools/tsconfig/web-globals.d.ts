declare var TextEncoder: {
  new (): {
    encode(input?: string): Uint8Array
    encodeInto(source: string, destination: Uint8Array): { read: number; written: number }
  }
}

declare function queueMicrotask(callback: () => void): void

declare function structuredClone<T>(value: T): T

interface URL {
  readonly protocol: string
  readonly hostname: string
  readonly pathname: string
  readonly search: string
}

declare var URL: {
  new (url: string): URL
}

declare namespace Intl {
  interface SegmentData {
    readonly segment: string
    readonly index: number
    readonly input: string
  }

  interface Segments {
    containing(codeUnitIndex?: number): SegmentData | undefined
  }

  interface SegmenterOptions {
    readonly granularity?: "grapheme" | "word" | "sentence"
  }

  interface Segmenter {
    segment(input: string): Segments
  }

  var Segmenter: {
    new (locales?: string | ReadonlyArray<string>, options?: SegmenterOptions): Segmenter
  }
}
