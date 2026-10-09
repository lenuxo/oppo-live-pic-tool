# Private regression fixtures

The repository intentionally excludes the three original photos and their EXIF metadata. Place your local copies here:

- `l1.jpg`: OPPO Find X9 HDR motion photo with Oplus extra data.
- `l2.jpg`: Oplus v2 / VESDK motion photo.
- `s1.jpg`: ordinary static HDR JPEG.

Tests requiring these exact fixtures skip automatically if any is absent. Synthetic tests and CLI capability/argument tests remain runnable. With the fixtures present, run `npm test` for the complete regression suite. Do not commit personal photos or derived media without reviewing and authorizing their publication.
