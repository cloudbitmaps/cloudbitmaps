/*
 * Taking markup out of a page's text for the gates that read what a reader sees. One pass of a replace is not enough:
 * removing one match can join the text around it into another, as `<!<!-- -->-- x -->` does, so the replace repeats
 * until nothing matches. Used by the figure, replay and calibration gates and by the docs tests.
 */
'use strict';

/** `text` with every match of `pattern` (a global regex) replaced by `replacement`, until none is left. */
function removeAll(text, pattern, replacement = '') {
  for (let previous; previous !== text;) {
    previous = text;
    text = text.replace(pattern, replacement);
  }
  return text;
}

module.exports = { removeAll };
