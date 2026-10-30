/**
 * Recall Regex Utilities — centralized regexes for memory-recall grammar and linting.
 *
 * @dft principle: Regexes reside in utils files only.
 */

export {
  PREDICATE_INTERNAL_PERIOD_REGEX,
  IMPERATIVE_MOOD_REGEX,
  MUST_FRAMING_REGEX,
  PATH_SHAPE_REGEX,
  ISO_8601_REGEX,
  KIND_LINE_REGEX,
  WHITESPACE_CHAR_REGEX,
  WHITESPACE_SEQUENCE_REGEX,
  MARKDOWN_HEADING_REGEX,
  MD_EXTENSION_REGEX,
  quoteTrimGlobal,
  backslashGlobal,
  edgeSlashes,
} from "../../shared/regex-library.ts";
