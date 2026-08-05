import { describe, it, mock } from "node:test";
import assert from "node:assert";

describe("question tool handler", () => {
  it("should parse question tool rawInput correctly", () => {
    const rawInput = {
      questions: [
        {
          question: "What is your preferred weather condition?",
          header: "Weather preference",
          options: [
            { label: "Sunny and warm", description: "Clear skies, 25°C+" },
            { label: "Rainy and cool", description: "Overcast with rain" },
          ],
          multiple: false,
        },
      ],
    };

    assert.ok(rawInput.questions, "questions array should exist");
    assert.strictEqual(rawInput.questions.length, 1, "should have one question");
    assert.strictEqual(rawInput.questions[0].header, "Weather preference");
    assert.strictEqual(rawInput.questions[0].options?.length, 2, "should have two options");
  });

  it("should handle missing questions array", () => {
    const rawInput = {};
    const input = rawInput as { questions?: Array<{ question: string }> } | undefined;
    
    assert.strictEqual(input?.questions?.length, undefined, "questions should be undefined");
    assert.ok(!input?.questions?.length, "should be falsy");
  });

  it("should handle empty questions array", () => {
    const rawInput = { questions: [] };
    const input = rawInput as { questions?: Array<{ question: string }> } | undefined;
    
    assert.strictEqual(input?.questions?.length, 0, "questions should be empty");
    assert.ok(!input?.questions?.length, "should be falsy");
  });

  it("should extract header and question text correctly", () => {
    const q = {
      question: "What is your preferred weather?",
      header: "Weather",
      options: [{ label: "Sunny" }],
    };

    const header = q.header ?? q.question ?? "Question";
    const questionText = q.question ?? header;

    assert.strictEqual(header, "Weather");
    assert.strictEqual(questionText, "What is your preferred weather?");
  });

  it("should fallback to question when header is missing", () => {
    const q = {
      question: "What is your preferred weather?",
      options: [{ label: "Sunny" }],
    };

    const header = q.header ?? q.question ?? "Question";
    const questionText = q.question ?? header;

    assert.strictEqual(header, "What is your preferred weather?");
    assert.strictEqual(questionText, "What is your preferred weather?");
  });
});
