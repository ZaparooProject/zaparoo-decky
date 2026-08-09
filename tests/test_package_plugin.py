import unittest

from scripts.package_plugin import validate_package, validate_plugin


class PackageValidationTests(unittest.TestCase):
    def test_validate_package_accepts_release_metadata(self):
        version = validate_package(
            {
                "name": "zaparoo-decky",
                "version": "2.17.0",
                "license": "GPL-3.0-or-later",
                "dependencies": {
                    "@decky/api": "^1.1.3",
                    "qrcode.react": "^4.2.0",
                    "react-icons": "^5.3.0",
                    "tslib": "^2.7.0",
                },
            }
        )

        self.assertEqual("2.17.0", version)

    def test_validate_package_rejects_unreviewed_runtime_dependency(self):
        with self.assertRaisesRegex(RuntimeError, "license inventory"):
            validate_package(
                {
                    "name": "zaparoo-decky",
                    "version": "2.17.0",
                    "license": "GPL-3.0-or-later",
                    "dependencies": {"unreviewed": "1.0.0"},
                }
            )

    def test_validate_package_rejects_invalid_version(self):
        with self.assertRaisesRegex(RuntimeError, "semantic"):
            validate_package(
                {
                    "name": "zaparoo-decky",
                    "version": "latest",
                    "license": "GPL-3.0-or-later",
                }
            )

    def test_validate_plugin_rejects_privileged_flags(self):
        with self.assertRaisesRegex(RuntimeError, "forbidden flags"):
            validate_plugin(
                {
                    "name": "Zaparoo",
                    "api_version": 1,
                    "flags": ["_root"],
                    "publish": {
                        "tags": ["utility"],
                        "description": "Zaparoo",
                        "image": "https://example.com/icon.png",
                    },
                }
            )

    def test_validate_plugin_accepts_unprivileged_metadata(self):
        validate_plugin(
            {
                "name": "Zaparoo",
                "api_version": 1,
                "flags": [],
                "publish": {
                    "tags": ["utility"],
                    "description": "Zaparoo",
                    "image": "https://example.com/icon.png",
                },
            }
        )


if __name__ == "__main__":
    unittest.main()
