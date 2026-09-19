/**
 * Web Worker for the minimax opponent.
 *
 * Accepts a GameState and options via postMessage, replies with the chosen column.
 * Runs in a separate thread so the UI never blocks.
 */

import type { GameState, Column } from './types';
import type { MinimaxOptions } from './minimax';
import { chooseMove } from './minimax';

interface WorkerMessage {
	state: GameState;
	options?: MinimaxOptions;
}

interface WorkerResponse {
	column: Column;
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
	const { state, options } = event.data;

	try {
		const column = chooseMove(state, options);
		const response: WorkerResponse = { column };
		self.postMessage(response);
	} catch (error) {
		// Post error back to main thread
		self.postMessage({
			error: error instanceof Error ? error.message : String(error),
		});
	}
};
