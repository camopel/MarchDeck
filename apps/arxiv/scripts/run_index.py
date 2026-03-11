#!/usr/bin/env python3
"""Run FAISS index build with progress written to status file."""
import json
import sys

def main():
    if len(sys.argv) < 4:
        print("Usage: run_index.py <db_path> <data_dir> <status_file>")
        sys.exit(1)

    db_path = sys.argv[1]
    data_dir = sys.argv[2]
    status_file = sys.argv[3]

    # Add scripts dir to path
    import os
    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, scripts_dir)

    from embed import build_index

    def progress(done, total):
        with open(status_file, 'w') as f:
            json.dump({"running": True, "message": f"Indexing {done}/{total}..."}, f)

    n = build_index(db_path, data_dir, progress)
    print(f"Indexed {n} papers")

if __name__ == "__main__":
    main()
