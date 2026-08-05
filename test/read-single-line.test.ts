import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";

class MockStdin extends EventEmitter {
  isTTY = true;
  private _rawMode = false;
  
  setRawMode(mode: boolean) {
    this._rawMode = mode;
    return this;
  }
  
  resume() {
    return this;
  }
  
  pause() {
    return this;
  }
  
  removeListener(event: string, listener: (...args: any[]) => void) {
    return super.removeListener(event, listener);
  }
  
  simulateInput(data: string | Buffer) {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    this.emit("data", buf);
  }
}

function readSingleLine(stdin: MockStdin): Promise<string> {
  let buf = "";
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      const str = chunk.toString("utf-8");
      if (str.includes("\x03")) {
        stdin.removeListener("data", onData);
        resolve("");
        return;
      }
      if (str.includes("\x1b")) return;
      
      const nlIdx = str.search(/[\r\n]/);
      if (nlIdx !== -1) {
        const beforeNl = str.slice(0, nlIdx);
        for (const ch of beforeNl) {
          if (ch === "\x7f" || ch === "\b") {
            if (buf.length > 0) {
              buf = buf.slice(0, -1);
            }
          } else if (ch >= " ") {
            buf += ch;
          }
        }
        stdin.removeListener("data", onData);
        resolve(buf);
        return;
      }
      
      if (str.includes("\x7f") || str.includes("\b")) {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
        }
        return;
      }
      for (const ch of str) {
        if (ch >= " ") {
          buf += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

describe("readSingleLine with discard handler", () => {
  let mockStdin: MockStdin;
  
  beforeEach(() => {
    mockStdin = new MockStdin();
  });
  
  it("readSingleLine should receive data even with discard handler active", async () => {
    // Attach discard handler (simulates setInputTarget("discard"))
    mockStdin.on("data", (chunk) => {
      // Discard handler just returns
      return;
    });
    
    // Start reading
    const readPromise = readSingleLine(mockStdin);
    
    // Simulate user typing "1" and pressing Enter
    mockStdin.simulateInput("1");
    mockStdin.simulateInput("\r");
    
    const result = await readPromise;
    assert.strictEqual(result, "1", "should receive the typed character");
  });
  
  it("readSingleLine should handle multiple characters before Enter", async () => {
    // Attach discard handler
    mockStdin.on("data", (chunk) => {
      return;
    });
    
    const readPromise = readSingleLine(mockStdin);
    
    // Simulate user typing "123" and pressing Enter
    mockStdin.simulateInput("1");
    mockStdin.simulateInput("2");
    mockStdin.simulateInput("3");
    mockStdin.simulateInput("\r");
    
    const result = await readPromise;
    assert.strictEqual(result, "123", "should receive all typed characters");
  });
  
  it("readSingleLine should handle Enter in same chunk as text", async () => {
    // Attach discard handler
    mockStdin.on("data", (chunk) => {
      return;
    });
    
    const readPromise = readSingleLine(mockStdin);
    
    // Simulate user typing "1" and pressing Enter in same chunk
    mockStdin.simulateInput("1\r");
    
    const result = await readPromise;
    assert.strictEqual(result, "1", "should receive the typed character");
  });
  
  it("readSingleLine should handle Ctrl+C", async () => {
    // Attach discard handler
    mockStdin.on("data", (chunk) => {
      return;
    });
    
    const readPromise = readSingleLine(mockStdin);
    
    // Simulate user pressing Ctrl+C
    mockStdin.simulateInput("\x03");
    
    const result = await readPromise;
    assert.strictEqual(result, "", "should return empty string on Ctrl+C");
  });
});
