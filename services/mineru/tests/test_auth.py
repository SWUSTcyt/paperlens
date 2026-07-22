from __future__ import annotations

import unittest

from paperlens_mineru.auth import require_bearer_token
from paperlens_mineru.contracts import ErrorCode
from paperlens_mineru.errors import ContractError


TOKEN = "correct-token-value-with-at-least-32-chars"


class AuthTests(unittest.TestCase):
    def test_accepts_exact_bearer_token(self) -> None:
        require_bearer_token(f"Bearer {TOKEN}", TOKEN)

    def test_missing_and_invalid_credentials_have_distinct_stable_codes(self) -> None:
        cases = [
            (None, ErrorCode.AUTH_REQUIRED),
            ("Basic abc", ErrorCode.AUTH_REQUIRED),
            ("Bearer wrong-token-value-with-at-least-32", ErrorCode.AUTH_INVALID),
        ]
        for header, code in cases:
            with self.subTest(header=header), self.assertRaises(ContractError) as raised:
                require_bearer_token(header, TOKEN)
            self.assertEqual(raised.exception.code, code)
            self.assertEqual(raised.exception.http_status, 401)
            self.assertNotIn(TOKEN, str(raised.exception))


if __name__ == "__main__":
    unittest.main()
