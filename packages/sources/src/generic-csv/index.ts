/**
 * Generic CSV adapter.
 *
 * Accepts common "universal CSV" ledger shapes used by crypto tax tools:
 * date, sent/received amounts, currencies, fees, labels, notes, and tx hashes.
 */

export {
  parseGenericCsv,
  type GenericCsvRow,
  type ParseGenericCsvOptions,
  type ParseGenericCsvResult,
} from './csv.js';
