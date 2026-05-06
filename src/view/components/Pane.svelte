<script lang="ts">
	export let onSendMessage: (message: string) => void;

	let messageInput = '';
	let messages: Array<{role: 'user' | 'assistant', content: string}> = [];

	function handleSend() {
		if (messageInput.trim()) {
			messages.push({ role: 'user', content: messageInput.trim() });
			onSendMessage(messageInput.trim());
			messageInput = '';
			messages = messages; // Trigger reactivity
		}
	}

	function handleKeyPress(event: KeyboardEvent) {
		event.stopPropagation();
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			handleSend();
		}
	}
</script>

<div class="volcano-pane">
	<div class="volcano-header">
		<h2>🌋 Volcano Agent</h2>
	</div>

	<div class="volcano-messages">
		{#each messages as message}
			<div class="message message-{message.role}">
				<div class="message-content">{message.content}</div>
			</div>
		{/each}
		{#if messages.length === 0}
			<div class="empty-state">
				Start a conversation with Volcano Agent...
			</div>
		{/if}
	</div>

	<div class="volcano-input">
		<textarea
			bind:value={messageInput}
			on:keydown={handleKeyPress}
			on:keyup|stopPropagation
			on:keypress|stopPropagation
			placeholder="Type your message... (Cmd+Enter to send)"
			rows="3"
		></textarea>
		<button on:click={handleSend} disabled={!messageInput.trim()}>
			Send
		</button>
	</div>
</div>

<style>
	.volcano-pane {
		display: flex;
		flex-direction: column;
		height: 100%;
		padding: 10px;
	}

	.volcano-header {
		border-bottom: 1px solid var(--background-modifier-border);
		padding-bottom: 10px;
		margin-bottom: 10px;
	}

	.volcano-header h2 {
		margin: 0;
		font-size: 16px;
		color: var(--text-normal);
	}

	.volcano-messages {
		flex: 1;
		overflow-y: auto;
		margin-bottom: 10px;
	}

	.message {
		margin-bottom: 10px;
		padding: 8px 12px;
		border-radius: 8px;
	}

	.message-user {
		background-color: var(--interactive-accent);
		color: var(--text-on-accent);
		margin-left: 20px;
	}

	.message-assistant {
		background-color: var(--background-modifier-hover);
		color: var(--text-normal);
		margin-right: 20px;
	}

	.message-content {
		word-wrap: break-word;
	}

	.empty-state {
		text-align: center;
		color: var(--text-muted);
		font-style: italic;
		padding: 40px 20px;
	}

	.volcano-input {
		display: flex;
		gap: 8px;
	}

	.volcano-input textarea {
		flex: 1;
		resize: none;
		padding: 8px;
		border: 1px solid var(--background-modifier-border);
		border-radius: 4px;
		background-color: var(--background-primary);
		color: var(--text-normal);
		font-family: var(--font-interface);
	}

	.volcano-input button {
		padding: 8px 16px;
		background-color: var(--interactive-accent);
		color: var(--text-on-accent);
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.volcano-input button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.volcano-input button:hover:not(:disabled) {
		background-color: var(--interactive-accent-hover);
	}
</style>