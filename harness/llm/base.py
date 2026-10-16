from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class ChatResponse:
    text: str
    prompt_tokens: int
    completion_tokens: int
    seconds: float

    @property
    def tokens(self):
        return self.prompt_tokens + self.completion_tokens


class LLMClient(ABC):
    @abstractmethod
    def chat(self, model: str, messages: list[dict],
             temperature: float = 0.2, json_mode: bool = False) -> ChatResponse:
        ...