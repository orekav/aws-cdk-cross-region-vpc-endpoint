import axios from "axios";

export async function handler(event, context) {
  const response = await axios.get(process.env.API_URL);

  console.log("Response", JSON.stringify(response.data));

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Hello World", data: response.data }),
  };
}
