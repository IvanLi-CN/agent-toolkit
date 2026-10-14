"""Regression tests for public marker and secret-pattern detection."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("public_boundary_check", ROOT / "bin/public_boundary_check.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def pattern(label: str):
    return next(regex for name, regex in MODULE.FORBIDDEN_PATTERNS if name == label)


class SecretPatternTests(unittest.TestCase):
    def test_bare_assignment_remains_detected(self):
        name = b"api_" + b"key"
        value = b'"0123456789abcdef"'
        self.assertIsNotNone(pattern("quoted-secret-assignment").search(name + b"=" + value))

    def test_prefixed_environment_assignment_is_detected(self):
        name = b"CVM_" + b"API_KEY"
        value = b'"0123456789abcdef"'
        self.assertIsNotNone(pattern("prefixed-quoted-secret-assignment").search(name + b"=" + value))

    def test_prefixed_password_assignment_is_detected(self):
        name = b"DATABASE_" + b"PASSWORD"
        value = b'"0123456789abcdef"'
        self.assertIsNotNone(pattern("prefixed-quoted-secret-assignment").search(name + b"=" + value))

    def test_lowercase_compound_secret_assignments_are_detected(self):
        for name in (b"database_" + b"password", b"aws_" + b"secret_access_key"):
            with self.subTest(name=name):
                value = b'"0123456789abcdef"'
                self.assertIsNotNone(pattern("prefixed-quoted-secret-assignment").search(name + b"=" + value))

    def test_camel_case_secret_assignments_are_detected(self):
        for name in (b"database" + b"Password", b"aws" + b"SecretAccessKey", b"secret" + b"Key"):
            with self.subTest(name=name):
                value = b'"0123456789abcdef"'
                self.assertIsNotNone(pattern("prefixed-quoted-secret-assignment").search(name + b"=" + value))

    def test_multi_segment_camel_case_secret_assignments_are_detected(self):
        for name in (b"appDatabase" + b"Password", b"serviceClient" + b"Secret"):
            with self.subTest(name=name):
                value = b'"0123456789abcdef"'
                self.assertIsNotNone(pattern("prefixed-quoted-secret-assignment").search(name + b"=" + value))

    def test_punctuation_leading_secret_values_are_detected(self):
        name = b"password"
        value = b'"' + b"!0123456789abcdef" + b'"'
        self.assertIsNotNone(pattern("quoted-secret-assignment").search(name + b"=" + value))

    def test_compound_json_secret_fields_are_detected(self):
        for name in (b"database_" + b"password", b"aws_" + b"secret_access_key", b"secret_" + b"key"):
            with self.subTest(name=name):
                field = b'"' + name + b'":"0123456789abcdef"'
                self.assertIsNotNone(pattern("json-secret-field").search(b"{" + field + b"}"))

    def test_camel_case_json_secret_fields_are_detected(self):
        for name in (b"database" + b"Password", b"client" + b"Secret", b"aws" + b"SecretAccessKey", b"secret" + b"Key"):
            with self.subTest(name=name):
                field = b'"' + name + b'":"0123456789abcdef"'
                self.assertIsNotNone(pattern("json-secret-field").search(b"{" + field + b"}"))

    def test_pascal_case_json_secret_fields_are_detected(self):
        for name in (b"Database" + b"Password", b"Client" + b"Secret", b"Aws" + b"SecretAccessKey", b"Secret" + b"Key"):
            with self.subTest(name=name):
                field = b'"' + name + b'":"0123456789abcdef"'
                self.assertIsNotNone(pattern("json-secret-field").search(b"{" + field + b"}"))

    def test_regex_literal_is_not_treated_as_a_secret_value(self):
        name = b"re_english_write_" + b"token"
        value = b'"(write|writes|writing|modify|modifies)"'
        content = b"local " + name + b"=" + value
        match = pattern("prefixed-quoted-secret-assignment").search(content)
        self.assertIsNotNone(match)
        self.assertTrue(MODULE._is_regex_helper_assignment(content, match))

    def test_parenthesis_and_bracket_leading_values_are_detected(self):
        for value in (b'"(0123456789abcdef"', b'"[0123456789abcdef"'):
            with self.subTest(value=value):
                name = b"password"
                content = name + b"=" + value
                self.assertIsNotNone(pattern("quoted-secret-assignment").search(content))

    def test_resembling_helper_names_are_not_excluded(self):
        for name in (b"redis_" + b"password", b"request_" + b"api_key"):
            with self.subTest(name=name):
                value = b'"(0123456789abcdef"'
                content = name + b"=" + value
                match = pattern("prefixed-quoted-secret-assignment").search(content)
                self.assertIsNotNone(match)
                self.assertFalse(MODULE._is_regex_helper_assignment(content, match))

    def test_long_hyphenated_non_secret_input_does_not_match(self):
        content = b"a-" * 8000 + b"!"
        self.assertIsNone(pattern("prefixed-quoted-secret-assignment").search(content))

    def test_json_secret_field_is_detected(self):
        field = b'"' + b"api_key" + b'":"0123456789abcdef"'
        self.assertIsNotNone(pattern("json-secret-field").search(b"{" + field + b"}"))

    def test_redacted_json_placeholder_is_not_detected(self):
        field = b'"' + b"api_key" + b'":"<redacted>"'
        self.assertIsNone(pattern("json-secret-field").search(b"{" + field + b"}"))


if __name__ == "__main__":
    unittest.main()
