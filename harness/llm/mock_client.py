from harness.llm.base import LLMClient, ChatResponse


class MockClient(LLMClient):
    def __init__(self, replies=None):
        self._replies = replies or ['{"title": "Mock event", "start": "2026-10-18T19:00", "venue": "Mock venue"}']
        self._i = 0

    def chat(self, model, messages, temperature=0.2):
        text = self._replies[self._i % len(self._replies)]
        self._i += 1
        return ChatResponse(
            text=text,
            prompt_tokens=sum(len(m["content"].split()) for m in messages),
            completion_tokens=max(1, len(text.split())),
            seconds=0.01,
        )