"""Bounded, displayable career material; imported text remains data, not instructions."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from pydantic import JsonValue

from nanobot.career.models import AnalysisSnapshot

MAX_CONTEXT_CHARS = 24_000
_EMAIL = re.compile(r"[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}")
_MOBILE = re.compile(r"(?<!\d)(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)")
_IDENTITY = re.compile(r"(?<!\w)\d{17}[\dXx](?!\w)")
_CONTACT_LINE = re.compile(
    r"(?im)^(\s*(?:电话|手机|邮箱|联系方式|身份证|住址|phone|mobile|email|e-mail|address)\s*[:：])[^\n]*"
)
_PATH = re.compile(r"[a-zA-Z]:[\\/][^\s\"<>]+|/(?:Users|home|root|tmp|var|mnt|private)/[^\s\"<>]+")
_PRIVATE_KEYS = frozenset({"email", "phone", "mobile", "address", "contact", "id_number", "path", "邮箱", "电话", "手机", "联系方式", "身份证", "住址", "文件路径"})
_AVAILABILITY_LINE = re.compile(
    r"(?im)^\s*(?:[-*•]\s*)?(?:到岗(?:安排|条件|时间|情况)?|实习安排|availability)\s*[:：]\s*([^\n]{1,400})$"
)
_AVAILABILITY_PATTERNS = {
    "days_per_week": re.compile(r"每周\s*([1-7一二三四五六七])\s*天|\b([1-7])\s*days?\s*(?:per|a)\s*week\b", re.I),
    "available_months": re.compile(r"(?:连续|持续)\s*(\d{1,2})\s*个?月|\b(\d{1,2})\s*months?\b", re.I),
}
_UNCERTAIN_AVAILABILITY = re.compile(
    r"暂定|可能|预计|待定|左右|至少|最多|以内|以上|以下|不超过|不确定|协商|或者|或|约|at least|up to|about|around|approximately|\bor\b|\bto\b|\d\.\d|\d\s*(?:[-~～—]|至|到)\s*\d", re.I,
)


def _resume_condition_differences(text: str, conditions: dict[str, JsonValue]) -> list[JsonValue]:
    """Compare only explicit, unambiguous labelled availability, never project numbers."""
    candidates: dict[str, dict[int, str]] = {key: {} for key in _AVAILABILITY_PATTERNS}
    for line in _AVAILABILITY_LINE.finditer(text):
        value = line.group(1)
        if _UNCERTAIN_AVAILABILITY.search(value):
            continue
        for fragment in re.split(r"[，,；;。]", value):
            for key, pattern in _AVAILABILITY_PATTERNS.items():
                match = pattern.fullmatch(fragment.strip().rstrip("."))
                if match is None:
                    continue
                number = next(group for group in match.groups() if group is not None)
                amount = "一二三四五六七".index(number) + 1 if number in "一二三四五六七" else int(number)
                if amount > 0:
                    candidates[key][amount] = line.group(0).strip()[:200]
    differences: list[JsonValue] = []
    for key, values in candidates.items():
        selected = conditions[key]
        if type(selected) is int and len(values) == 1:
            original, evidence = next(iter(values.items()))
            if selected != original:
                differences.append({"field": key, "selected": selected, "resume": original, "evidence": evidence})
    return differences


def redact(text: str) -> str:
    text = "".join(character for character in text if character in "\n\t" or ord(character) >= 32)
    text = _CONTACT_LINE.sub(r"\1 [已隐藏]", text)
    for pattern in (_EMAIL, _MOBILE, _IDENTITY, _PATH):
        text = pattern.sub("[已隐藏]", text)
    return text


def _encoded(text: str) -> str:
    return json.dumps(text, ensure_ascii=False).replace("[", "\\u005b").replace("]", "\\u005d")


def _text(text: str, budget: int) -> tuple[str, bool]:
    cleaned = redact(text)
    end = min(len(cleaned), budget)
    while len(_encoded(cleaned[:end])) > budget:
        end = end * 3 // 4
    return cleaned[:end], end < len(cleaned)


def _fields(value: JsonValue, depth: int = 0) -> tuple[JsonValue, bool]:
    if depth > 3:
        return "[已截取]", True
    if isinstance(value, dict):
        result: dict[str, JsonValue] = {}
        cut = len(value) > 16
        for key, item in list(value.items())[:16]:
            if key.strip().lower().replace("-", "_") in _PRIVATE_KEYS:
                continue
            result[redact(key)[:80]], item_cut = _fields(item, depth + 1)
            cut = cut or item_cut or len(key) > 80
        return result, cut
    if isinstance(value, list):
        items = [_fields(item, depth + 1) for item in value[:16]]
        return [item for item, _ in items], len(value) > 16 or any(cut for _, cut in items)
    if isinstance(value, str):
        return _text(value, 300)
    return value, False


@dataclass(frozen=True)
class CareerMaterials:
    payload: dict[str, JsonValue]
    content: str
    truncated: bool


def build_materials(snapshot: AnalysisSnapshot) -> CareerMaterials:
    resume_text, resume_cut = _text(snapshot.resume.text, 8_000)
    job_text, job_cut = _text(snapshot.job.text, 8_000)
    resume_name = _text(snapshot.resume.name, 400)[0]
    job_name = _text(snapshot.job.name, 400)[0]
    profile, profile_cut = _fields(snapshot.resume.profile)
    requirements, requirements_cut = _fields(snapshot.job.requirements)
    conditions: dict[str, JsonValue] = {
        "days_per_week": snapshot.conditions.days_per_week,
        "available_months": snapshot.conditions.available_months,
        "available_from": snapshot.conditions.available_from.isoformat() if snapshot.conditions.available_from else None,
        "locations": [_text(value, 200)[0] for value in snapshot.conditions.locations[:10]],
    }
    payload: dict[str, JsonValue] = {
        "resume": {"id": snapshot.resume.id, "name": resume_name, "version": snapshot.resume.version, "text": resume_text, "profile": profile},
        "job": {"id": snapshot.job.id, "name": job_name, "version": snapshot.job.version, "company": _text(snapshot.job.company or "", 400)[0], "text": job_text, "requirements": requirements},
        "conditions": conditions,
        "availability_conflicts": [],
        "resume_condition_differences": _resume_condition_differences(resume_text, conditions),
        "truncated": resume_cut or job_cut or profile_cut or requirements_cut,
    }
    conflicts: list[JsonValue] = []
    for key in ("days_per_week", "available_months"):
        required = snapshot.job.requirements.get(key)
        available = conditions[key]
        if type(required) is int and type(available) is int and available < required:
            conflicts.append({"field": key, "available": available, "required": required})
    payload["availability_conflicts"] = conflicts
    truncated = resume_cut or job_cut or profile_cut or requirements_cut
    # Structured extras are optional. The confirmed original text has priority.
    def render() -> str:
        return json.dumps(payload, ensure_ascii=False).replace("[", "\\u005b").replace("]", "\\u005d")
    if len(render()) > MAX_CONTEXT_CHARS:
        resume = payload["resume"]
        job = payload["job"]
        assert isinstance(resume, dict) and isinstance(job, dict)
        resume["profile"] = {}
        job["requirements"] = {}
        payload["truncated"] = truncated = True
    content = render()
    if len(content) > MAX_CONTEXT_CHARS:
        raise ValueError("career material exceeds the context budget")
    return CareerMaterials(payload=payload, content=content, truncated=truncated)
