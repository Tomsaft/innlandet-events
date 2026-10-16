from harness.llm.base import LLMClient, ChatResponse


def __init__(self, replies=None):
    self._replies = replies or [
        '{"category": "concert", "summary_en": "Mock summary.", '
        '"summary_no": "Mock sammendrag.", "student_fit": 2}'
    ]
    self._i = 0

    def chat(self, model, messages, temperature=0.2, json_mode=False):
        text = self._replies[self._i % len(self._replies)]
        self._i += 1
        return ChatResponse(
            text=text,
            prompt_tokens=sum(len(m["content"].split()) for m in messages),
            completion_tokens=max(1, len(text.split())),
            seconds=0.01,
        )