# ascidrive

A endless night drive in your terminal, all in plain ASCII. No dependancies, just node.

## Run it

    npm start

or `node bin/drive.js`. If your terminal is slow try `--fps 30`, and `--seed N` gives you a diffrent road.

## Terminal size

You need atleast **120 columns x 60 rows**. If the window is smaller it just tells you to resize. Bigger is better, so go full screen and make the font small.

## Keys

| Key    | What it does                  |
|--------|-------------------------------|
| f      | go faster (hold it)           |
| s      | slow down (hold it)           |
| t      | drive in / out of a tunnel    |
| q      | quit                          |
| Ctrl-C | shows the keys for a few secs (it does NOT quit) |
