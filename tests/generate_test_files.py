#!/usr/bin/env python3
"""
Generate test markdown files with valid coordinates for Obsidian Maps plugin testing.

Usage:
    python generate_test_files.py [count]

Arguments:
    count: Number of files to generate (default: 100)
"""

import os
import sys
import random
from pathlib import Path

# Lists for generating random place names
ADJECTIVES = [
    "Ancient", "Beautiful", "Charming", "Historic", "Grand", "Royal", "Sacred",
    "Old", "New", "Golden", "Silver", "Crystal", "Hidden", "Mystic", "Noble",
    "Imperial", "Modern", "Contemporary", "Traditional", "Peaceful", "Busy",
    "Central", "Northern", "Southern", "Eastern", "Western", "Coastal", "Mountain",
    "River", "Lake", "Forest", "Urban", "Rural", "Metropolitan"
]

PLACE_TYPES = [
    "Museum", "Gallery", "Park", "Garden", "Plaza", "Square", "Tower", "Castle",
    "Cathedral", "Church", "Temple", "Monastery", "Palace", "Monument", "Memorial",
    "Library", "Theater", "Opera House", "Concert Hall", "Market", "Bazaar",
    "Restaurant", "Cafe", "Hotel", "Bridge", "Station", "Port", "Harbor",
    "University", "School", "Hospital", "Fountain", "Statue", "Building",
    "Center", "District", "Quarter", "Street", "Avenue", "Boulevard"
]

PLACE_NAMES = [
    "St. James", "Victoria", "Alexander", "Elizabeth", "Charles", "William",
    "Margaret", "George", "Henry", "Louis", "Napoleon", "Augustus", "Caesar",
    "Cleopatra", "Athena", "Apollo", "Zeus", "Jupiter", "Neptune", "Venus",
    "Liberty", "Freedom", "Unity", "Peace", "Hope", "Faith", "Grace",
    "Washington", "Lincoln", "Jefferson", "Roosevelt", "Kennedy", "Churchill"
]

# Place types with their link format
PLACE_LINK_TYPES = [
    "Church", "Museum", "Restaurant", "Cafe", "Park", "Gallery", "Theater",
    "Library", "University", "Hospital", "Hotel", "Market", "Monument",
    "Castle", "Cathedral", "Temple", "Mosque", "Synagogue", "Shrine",
    "Beach", "Mountain", "Lake", "River", "Bridge", "Tower", "Palace",
    "Fort", "Memorial", "Station", "Airport", "Port", "Garden", "Zoo",
    "Aquarium", "Stadium", "Arena", "Mall", "Shop", "Bar", "Club",
    "Gym", "Spa", "Cinema", "School", "Cemetery", "Plaza", "Square"
]

# Broader geographic regions for more spread out coordinates
# Format: (lat_min, lat_max, lon_min, lon_max)
WORLD_REGIONS = [
    # Europe - broader coverage
    {"name": "Western Europe", "lat": (42.0, 55.0), "lon": (-5.0, 10.0)},
    {"name": "Central Europe", "lat": (45.0, 54.0), "lon": (10.0, 25.0)},
    {"name": "Southern Europe", "lat": (36.0, 45.0), "lon": (-9.0, 20.0)},
    {"name": "Northern Europe", "lat": (54.0, 70.0), "lon": (5.0, 30.0)},
    {"name": "Eastern Europe", "lat": (45.0, 60.0), "lon": (20.0, 40.0)},
    
    # North America - broader coverage
    {"name": "Northeast US", "lat": (38.0, 47.0), "lon": (-80.0, -66.0)},
    {"name": "Southeast US", "lat": (25.0, 38.0), "lon": (-90.0, -75.0)},
    {"name": "Midwest US", "lat": (36.0, 49.0), "lon": (-104.0, -80.0)},
    {"name": "Southwest US", "lat": (31.0, 42.0), "lon": (-125.0, -103.0)},
    {"name": "West Coast US", "lat": (32.0, 49.0), "lon": (-125.0, -116.0)},
    {"name": "Canada East", "lat": (42.0, 60.0), "lon": (-95.0, -52.0)},
    {"name": "Canada West", "lat": (48.0, 60.0), "lon": (-140.0, -95.0)},
    {"name": "Mexico", "lat": (14.5, 32.5), "lon": (-117.0, -86.0)},
    {"name": "Central America", "lat": (7.0, 18.0), "lon": (-92.0, -77.0)},
    {"name": "Caribbean", "lat": (10.0, 27.0), "lon": (-85.0, -59.0)},
    
    # South America - broader coverage
    {"name": "Brazil North", "lat": (-10.0, 5.0), "lon": (-75.0, -35.0)},
    {"name": "Brazil South", "lat": (-34.0, -10.0), "lon": (-75.0, -35.0)},
    {"name": "Argentina", "lat": (-55.0, -22.0), "lon": (-73.0, -53.0)},
    {"name": "Andean Region", "lat": (-20.0, 12.0), "lon": (-81.0, -66.0)},
    
    # Asia - broader coverage
    {"name": "East Asia", "lat": (20.0, 50.0), "lon": (100.0, 145.0)},
    {"name": "Southeast Asia", "lat": (-10.0, 25.0), "lon": (95.0, 140.0)},
    {"name": "South Asia", "lat": (5.0, 35.0), "lon": (60.0, 95.0)},
    {"name": "Central Asia", "lat": (35.0, 55.0), "lon": (46.0, 87.0)},
    {"name": "Middle East", "lat": (12.0, 42.0), "lon": (34.0, 63.0)},
    {"name": "Japan", "lat": (30.0, 46.0), "lon": (129.0, 146.0)},
    
    # Africa - broader coverage
    {"name": "North Africa", "lat": (15.0, 37.0), "lon": (-17.0, 51.0)},
    {"name": "West Africa", "lat": (4.0, 20.0), "lon": (-17.0, 15.0)},
    {"name": "East Africa", "lat": (-12.0, 15.0), "lon": (22.0, 51.0)},
    {"name": "Southern Africa", "lat": (-35.0, -12.0), "lon": (11.0, 42.0)},
    
    # Oceania - broader coverage
    {"name": "Australia East", "lat": (-44.0, -10.0), "lon": (140.0, 154.0)},
    {"name": "Australia West", "lat": (-35.0, -13.0), "lon": (113.0, 130.0)},
    {"name": "New Zealand", "lat": (-47.0, -34.0), "lon": (166.0, 179.0)},
    {"name": "Pacific Islands", "lat": (-25.0, 15.0), "lon": (140.0, -140.0)},
]


def generate_random_place_name():
    """Generate a random place name."""
    pattern = random.choice([
        lambda: f"{random.choice(ADJECTIVES)} {random.choice(PLACE_TYPES)}",
        lambda: f"{random.choice(PLACE_NAMES)} {random.choice(PLACE_TYPES)}",
        lambda: f"{random.choice(PLACE_NAMES)}'s {random.choice(PLACE_TYPES)}",
        lambda: f"The {random.choice(ADJECTIVES)} {random.choice(PLACE_TYPES)}",
        lambda: f"{random.choice(PLACE_TYPES)} of {random.choice(PLACE_NAMES)}",
    ])
    return pattern()


def generate_coordinates():
    """Generate random coordinates within a geographic region."""
    region = random.choice(WORLD_REGIONS)
    
    lat = random.uniform(region["lat"][0], region["lat"][1])
    lon = random.uniform(region["lon"][0], region["lon"][1])
    
    # Format with high precision like the example
    return f"{lat:.14f}", f"{lon:.7f}"


def generate_place_type():
    """Generate a random place type in [[Type]] format."""
    return f"[[{random.choice(PLACE_LINK_TYPES)}]]"


def create_markdown_file(directory, filename, coordinates, place_type):
    """Create a markdown file with YAML frontmatter."""
    content = f"""---
category: "[[Places]]"
type: "{place_type}"
coordinates:
  - "{coordinates[0]}"
  - "{coordinates[1]}"
---
"""
    
    filepath = directory / filename
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)


def generate_test_files(count=100, output_dir="generated_places"):
    """Generate test markdown files with coordinates."""
    # Create output directory
    script_dir = Path(__file__).parent
    output_path = script_dir / output_dir
    output_path.mkdir(exist_ok=True)
    
    print(f"Generating {count} test files in {output_path}...")
    
    # Keep track of generated names to avoid duplicates
    generated_names = set()
    
    for i in range(count):
        # Generate unique place name
        attempt = 0
        while attempt < 100:  # Prevent infinite loop
            place_name = generate_random_place_name()
            if place_name not in generated_names:
                generated_names.add(place_name)
                break
            attempt += 1
        else:
            # If we can't find a unique name, append a number
            place_name = f"{generate_random_place_name()} {i}"
        
        # Generate coordinates and type
        coordinates = generate_coordinates()
        place_type = generate_place_type()
        
        # Create filename
        filename = f"{place_name}.md"
        
        # Create the file
        create_markdown_file(output_path, filename, coordinates, place_type)
        
        # Print progress for large batches
        if (i + 1) % 1000 == 0:
            print(f"  Generated {i + 1} files...")
    
    print(f"✓ Successfully generated {count} files in {output_path}/")
    return output_path


def main():
    """Main entry point."""
    count = 100  # Default
    
    if len(sys.argv) > 1:
        try:
            count = int(sys.argv[1])
            if count < 1:
                print("Error: Count must be a positive integer")
                sys.exit(1)
        except ValueError:
            print(f"Error: Invalid count '{sys.argv[1]}'. Must be an integer.")
            sys.exit(1)
    
    generate_test_files(count)


if __name__ == "__main__":
    main()

