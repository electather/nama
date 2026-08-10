import NamaAPI
import SwiftProtobuf
import XCTest

final class ContractTests: XCTestCase {
  func testCommonContractRoundTrip() throws {
    var header = Nama_Api_V1_HttpHeader()
    header.name = "x-test"
    header.value = "public"

    let encoded = try header.serializedData()
    let decoded = try Nama_Api_V1_HttpHeader(serializedBytes: encoded)
    XCTAssertEqual(decoded, header)

    _ = Google_Rpc_ErrorInfo()
    _ = Google_Rpc_BadRequest()
    _ = Google_Rpc_RequestInfo()
    _ = Google_Rpc_RetryInfo()
  }
}
