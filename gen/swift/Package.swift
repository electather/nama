// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "NamaAPI",
    platforms: [
        .tvOS(.v17),
        .macOS(.v10_15)
    ],
    products: [
        .library(name: "NamaAPI", targets: ["NamaAPI"])
    ],
    dependencies: [
        .package(
            url: "https://github.com/connectrpc/connect-swift.git",
            exact: "1.2.3"
        ),
        .package(
            url: "https://github.com/apple/swift-protobuf.git",
            exact: "1.38.1"
        )
    ],
    targets: [
        .target(
            name: "NamaAPI",
            dependencies: [
                .product(name: "Connect", package: "connect-swift"),
                .product(name: "SwiftProtobuf", package: "swift-protobuf")
            ]
        )
    ]
)
