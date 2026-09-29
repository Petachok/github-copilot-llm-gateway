import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RepetitionDetector } from '../repetitionDetector';

/** Feed `text` in fixed-size chunks; return true as soon as the detector fires. */
function feed(detector: RepetitionDetector, text: string, chunkSize: number): boolean {
  for (let i = 0; i < text.length; i += chunkSize) {
    if (detector.push(text.slice(i, i + chunkSize))) {
      return true;
    }
  }
  return false;
}

const SENTENCE = 'I should check the configuration file again before answering. ';

const PARAGRAPH =
  'The request handler converts the messages, budgets the context window, and streams the reply. ' +
  'If the server rejects the prompt as too long, it learns the real window and retries once. ' +
  'Tool calls are repaired before they are reported, so a truncated argument still runs cleanly. ';

describe('RepetitionDetector', () => {
  test('ignores empty pushes', () => {
    assert.equal(new RepetitionDetector().push(''), false);
  });

  test('flags a sentence repeated over and over, fed in small chunks', () => {
    const detector = new RepetitionDetector();
    assert.equal(feed(detector, 'Let me look at this. ', 5), false);
    assert.equal(feed(detector, SENTENCE.repeat(80), 7), true);
  });

  test('fires within a bounded amount of repeated output', () => {
    const detector = new RepetitionDetector();
    const text = SENTENCE.repeat(80);
    let consumed = 0;
    for (let i = 0; i < text.length; i += 3) {
      consumed += 3;
      if (detector.push(text.slice(i, i + 3))) {
        break;
      }
    }
    // 2000-char span plus one check interval plus one unit of slack.
    assert.ok(consumed <= 2000 + 256 + SENTENCE.length, `fired after ${consumed} chars`);
  });

  test('tolerates whitespace differences between repeats', () => {
    const separators = ['\n', '\n\n', '  ', ' \n '];
    let text = '';
    for (let i = 0; i < 80; i++) {
      text += SENTENCE.trim() + separators[i % separators.length];
    }
    assert.equal(feed(new RepetitionDetector(), text, 11), true);
  });

  test('does not flag a paragraph repeated a few times', () => {
    assert.equal(new RepetitionDetector().push(PARAGRAPH.repeat(5)), false);
  });

  test('flags a paragraph repeated many times', () => {
    assert.equal(new RepetitionDetector().push(PARAGRAPH.repeat(9)), true);
  });

  test('a short unit needs a longer run before it is flagged', () => {
    const unit = 'alpha beta gamma 1; ';
    assert.equal(new RepetitionDetector().push(unit.repeat(90)), false);
    assert.equal(new RepetitionDetector().push(unit.repeat(110)), true);
  });

  test('lets identical boilerplate through', () => {
    const calendar = '<div class="day"></div>\n'.repeat(35);
    const mockRows = '  { "id": 0, "name": "", "active": false },\n'.repeat(30);
    const inserts = "INSERT INTO users (name) VALUES ('test');\n".repeat(20);
    assert.equal(feed(new RepetitionDetector(), calendar + mockRows + inserts, 13), false);
  });

  test('ignores low-variety runs such as separator lines and zero arrays', () => {
    assert.equal(feed(new RepetitionDetector(), '-'.repeat(3000), 50), false);
    assert.equal(feed(new RepetitionDetector(), '0, '.repeat(1000), 50), false);
    assert.equal(feed(new RepetitionDetector(), '| --- '.repeat(500), 50), false);
  });

  test('does not flag ordinary varied output', () => {
    let table = '| id | value |\n| --- | --- |\n';
    for (let i = 0; i < 150; i++) {
      table += `| row ${i} | ${i * 7} |\n`;
    }
    let code = '';
    for (let i = 0; i < 80; i++) {
      code += `  assert.equal(result[${i}].name, 'item-${i}');\n`;
    }
    const detector = new RepetitionDetector();
    assert.equal(feed(detector, PARAGRAPH + table + code + PARAGRAPH, 9), false);
  });
});
