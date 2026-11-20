const { Transform } = require('node:stream');

const mouseOn = '\x1b[?1006h\x1b[?1003h';
const mouseOff = '\x1b[?1003l\x1b[?1006l';

// Split terminal mouse reports from keystrokes before readline sees the input.
class TerminalInput extends Transform {
  constructor(tty) {
    super();
    this.tty = tty;
    this.pending = '';
  }

  get isRaw() { return this.tty.isRaw; }
  setRawMode(mode) { return this.tty.setRawMode(mode); }

  sendKeys(bytes) {
    if (this.keyTarget) this.keyTarget.write(bytes);
    else this.push(bytes);
  }

  pointer(button, x, y) {
    const motion = (button & 32) !== 0;
    if (button < 64 && (motion || (button & 3) === 0) && x > 0 && y > 0) {
      this.emit('pointer', x - 1, y - 1);
      if (!motion && (button & 3) === 0) this.emit('click', x - 1, y - 1);
    }
  }

  _transform(chunk, encoding, done) {
    clearTimeout(this.escapeTimer);
    // Latin-1 preserves each byte, including UTF-8 text and legacy mouse coordinates.
    const data = this.pending + chunk.toString('latin1');
    this.pending = '';
    let offset = 0;
    while (offset < data.length) {
      const start = data.indexOf('\x1b', offset);
      const end = start === -1 ? data.length : start;
      if (end > offset) this.sendKeys(Buffer.from(data.slice(offset, end), 'latin1'));
      if (start === -1) break;
      const rest = data.slice(start);
      const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
      if (sgr) {
        if (sgr[4] === 'M') this.pointer(Number(sgr[1]), Number(sgr[2]), Number(sgr[3]));
        offset = start + sgr[0].length;
      } else if (rest.startsWith('\x1b[M') && rest.length >= 6) {
        this.pointer(rest.charCodeAt(3) - 32, rest.charCodeAt(4) - 32, rest.charCodeAt(5) - 32);
        offset = start + 6;
      } else if (rest === '\x1b' || rest === '\x1b[' || /^\x1b\[<[\d;]{0,30}$/.test(rest) || rest.startsWith('\x1b[M')) {
        this.pending = rest;
        // A bare Escape can also be a key. Allow fragmented input to arrive first.
        if (rest.length <= 2) this.escapeTimer = setTimeout(() => this.flushEscape(), 80);
        break;
      } else {
        this.sendKeys(Buffer.from([27]));
        offset = start + 1;
      }
    }
    done();
  }

  flushEscape() {
    if (this.pending.length <= 2 && this.pending) this.sendKeys(Buffer.from(this.pending, 'latin1'));
    this.pending = '';
  }

  _flush(done) {
    clearTimeout(this.escapeTimer);
    this.flushEscape();
    done();
  }

  _destroy(error, done) {
    clearTimeout(this.escapeTimer);
    done(error);
  }
}

module.exports = { TerminalInput, mouseOn, mouseOff };
