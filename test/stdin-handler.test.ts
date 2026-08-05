import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { Readable, Writable } from "node:stream";
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
  
  simulateInput(data: string | Buffer) {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    this.emit("data", buf);
  }
}

describe("stdin handler interaction", () => {
  let mockStdin: MockStdin;
  
  beforeEach(() => {
    mockStdin = new MockStdin();
  });
  
  it("multiple data listeners should both receive data", async () => {
    let listener1Called = false;
    let listener2Called = false;
    
    mockStdin.on("data", (chunk) => {
      listener1Called = true;
    });
    
    mockStdin.on("data", (chunk) => {
      listener2Called = true;
    });
    
    mockStdin.simulateInput("test");
    
    assert.ok(listener1Called, "first listener should be called");
    assert.ok(listener2Called, "second listener should be called");
  });
  
  it("discard handler should not prevent other handlers from receiving data", async () => {
    let readLineCalled = false;
    
    // Simulate the discard handler
    mockStdin.on("data", (chunk) => {
      // Discard handler just returns
      return;
    });
    
    // Simulate readSingleLine handler
    mockStdin.on("data", (chunk) => {
      const str = chunk.toString("utf-8");
      if (str.includes("\r")) {
        readLineCalled = true;
      }
    });
    
    mockStdin.simulateInput("\r");
    
    assert.ok(readLineCalled, "readSingleLine handler should still receive data");
  });
  
  it("readSingleLine should detect Enter key", async () => {
    let receivedEnter = false;
    
    mockStdin.on("data", (chunk) => {
      const str = chunk.toString("utf-8");
      if (str.includes("\r") || str.includes("\n")) {
        receivedEnter = true;
      }
    });
    
    mockStdin.simulateInput("\r");
    
    assert.ok(receivedEnter, "should detect Enter key");
  });
});
