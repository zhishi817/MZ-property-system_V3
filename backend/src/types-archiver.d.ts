declare module 'archiver' {
  type ArchiverInstance = {
    append(source: Buffer | string, data: { name: string }): ArchiverInstance
    pipe(destination: NodeJS.WritableStream): ArchiverInstance
    finalize(): Promise<void>
    on(event: 'error', listener: (err: any) => void): ArchiverInstance
  }

  export default function archiver(format: 'zip', options?: { zlib?: { level?: number } }): ArchiverInstance
}
