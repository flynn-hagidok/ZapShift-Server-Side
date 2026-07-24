const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
require("dotenv").config();
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

const client = new MongoClient(`mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.zgye7fw.mongodb.net/?appName=Cluster0`);


async function connectToMongoDB() {
    try {
        await client.connect();
        const db = client.db("zapShift_db");
        const percelsCollection = db.collection("parcels");

        app.get("/parcels", async (req, res) => {
            const query = {};
            const { email } = req.query;
            if (email) {
                query.senderEmail = email;
            }
            const result = await percelsCollection.find(query).toArray();
            res.send(result);
        });

        app.post("/parcels", async (req, res) => {
            const parcels = req.body;
            const result = await percelsCollection.insertOne(parcels);
            res.send(result);
        })
    } catch (err) {
        console.dir(err);
    }
}

connectToMongoDB();

app.get("/", (req, res) => {
    res.send("zapshift server is running");
});

app.listen(port, (req, res) => {
    console.log(`server is running in port`, port);
});