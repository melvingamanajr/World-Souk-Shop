import { emitKeypressEvents } from 'node:readline';

export function promptHidden(input, output, message) {
  return new Promise((resolve, reject) => {
    const previousRaw = input.isRaw;
    let value = '';
    emitKeypressEvents(input);

    function finish(error) {
      input.removeListener('keypress', readKey);
      input.setRawMode(previousRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    }

    function readKey(character, key) {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') finish(new Error('Input canceled.'));
      else if (['return', 'enter'].includes(key.name)) finish();
      else if (key.name === 'backspace') value = Array.from(value).slice(0, -1).join('');
      else if (character && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/u.test(character) && value.length < 1024) value += character;
    }

    output.write(message);
    input.setRawMode(true);
    input.on('keypress', readKey);
    input.resume();
  });
}
