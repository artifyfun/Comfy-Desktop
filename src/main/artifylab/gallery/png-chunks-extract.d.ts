declare module 'png-chunks-extract' {
  interface PngChunk {
    name: string
    data: Uint8Array
  }

  export default function extractChunks(data: Buffer | Uint8Array): PngChunk[]
}
