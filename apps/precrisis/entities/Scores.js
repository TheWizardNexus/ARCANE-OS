import Is from '../../../node_modules/strong-type/index.js';
import '../../../arcane/modules/DBOPFS.js';

const is = new Is(false);

function parseStoredRecord(record) {
	if (!is.string(record)) {
		return record;
	}

	try {
		return JSON.parse(record);
	} catch(err) {
		return record;
	}
}

/**
 * Scores
 *
 * Loads collections of score records from OPFS.
 */
class Scores {

	/**
	 * Loads normalized OPFS score records.
	 *
	 * @returns {Promise<Object[]>}
	 */
	static async getAll() {
		const items = await dbopfs.getAll('scores');
		const storedRecords = Object.values(items);
		const records = [];

		for (let i = 0; i < storedRecords.length; i++) {
			const record = parseStoredRecord(storedRecords[i]);

			if (!record || typeof record !== 'object' || Array.isArray(record)) {
				continue;
			}

			records.push(record);
		}

		return records;
	}

}

export default Scores;
