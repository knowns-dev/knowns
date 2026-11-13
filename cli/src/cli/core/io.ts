/** Output sinks. Commands write through these so tests can run the CLI in-process. */
import { writeSync } from "node:fs";

export interface Sink {
  write(text: string): void;
}

export interface IO {
  out: Sink;
  err: Sink;
}

function fdSink(fd: number): Sink {
  return {
    write(text: string): void {
      if (text === "") return;
      const buf = Buffer.from(text, "utf8");
      let off = 0;
      while (off < buf.length) {
        try {
          off += writeSync(fd, buf, off, buf.length - off);
        } catch (e) {
          // A non-blocking pipe that is momentarily full: retry. A closed pipe: stop quietly.
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EAGAIN") continue;
          if (code === "EPIPE") return;
          throw e;
        }
      }
    },
  };
}

/** Synchronous writes to fd 1 and 2, so output is flushed before the process exits. */
export function stdIO(): IO {
  return { out: fdSink(1), err: fdSink(2) };
}

/** Collects output in memory. */
export class MemorySink implements Sink {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

export function memoryIO(): { io: IO; out: MemorySink; err: MemorySink } {
  const out = new MemorySink();
  const err = new MemorySink();
  return { io: { out, err }, out, err };
}
