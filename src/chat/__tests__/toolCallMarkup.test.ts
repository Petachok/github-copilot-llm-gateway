import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallMarkupScanner } from '../toolCallMarkup';

const GLM_CALL = '<tool_call>grep_search\n<arg_key>includePattern</arg_key>\n<arg_value>src/**</arg_value>\n</tool_call>';

/** Feed `text` in fixed-size pieces and collect what the scanner lets through. */
function scan(text: string, chunkSize: number): { shown: string; cut: boolean } {
  const scanner = new ToolCallMarkupScanner();
  let shown = '';
  let cut = false;
  for (let i = 0; i < text.length; i += chunkSize) {
    const result = scanner.push(text.slice(i, i + chunkSize));
    shown += result.text;
    cut ||= result.cut;
  }
  shown += scanner.flush();
  return { shown, cut };
}

describe('ToolCallMarkupScanner', () => {
  test('passes ordinary text through, including angle brackets and links', () => {
    const text = 'Generic<T> types, a [link](url), x < y and `<div>` tags.';
    for (const size of [1, 3, 7, 100]) {
      assert.deepEqual(scan(text, size), { shown: text, cut: false });
    }
  });

  test('cuts at the marker however the chunks split it', () => {
    const text = `Let me try a broader search approach.${GLM_CALL}`;
    for (const size of [1, 2, 5, 11, 1000]) {
      assert.deepEqual(scan(text, size), { shown: 'Let me try a broader search approach.', cut: true }, `chunk size ${size}`);
    }
  });

  test('recognises the other common native syntaxes', () => {
    for (const marker of ['[TOOL_CALLS]', '<function=read_file>', '<|python_tag|>', '<｜tool▁calls▁begin｜>', '<|tool_call|>']) {
      assert.deepEqual(scan(`Checking.${marker}{"a":1}`, 4), { shown: 'Checking.', cut: true }, marker);
    }
  });

  test('stays cut for the rest of the stream', () => {
    const scanner = new ToolCallMarkupScanner();
    assert.deepEqual(scanner.push('<tool_call>x'), { text: '', cut: true });
    assert.deepEqual(scanner.push('</tool_call>Done.'), { text: '', cut: true });
    assert.equal(scanner.flush(), '');
  });

  test('releases a held partial prefix that never became a marker', () => {
    const scanner = new ToolCallMarkupScanner();
    assert.deepEqual(scanner.push('see <tool'), { text: 'see ', cut: false });
    assert.deepEqual(scanner.push('bar> for details'), { text: '<toolbar> for details', cut: false });
    assert.deepEqual(scanner.push('and <'), { text: 'and ', cut: false });
    assert.equal(scanner.flush(), '<');
  });
});
