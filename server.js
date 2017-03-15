var os = require('os');
var request = require('request');
var morgan = require('morgan');
var bodyParser = require('body-parser');
var flat = require('flat');
var validate = require('validate.js');
var _ = require('underscore');
var MongoClient = require('mongodb').MongoClient;
var ObjectId = require('mongodb').ObjectID;
var express = require('express');

var mongoDBConnStr = process.env.MONGO_DB_CONNECTION_STRING;
var mongoDBCollection = process.env.MONGO_DB_COLLECTION;
console.log("MongoDB connection string: " + mongoDBConnStr);

// Will be initialized on server startup at the bottom
// Init to prototype to enable Intellisense
var mongoDB = require('mongodb').Db.prototype;

validate.validators.illegal = function(value, options, key, attributes) {
    if (value !== undefined && options) {
        return "cannot be provided";
    }
}

var incomingBikeSchema = {
    id: {
        illegal: true
    },
    available: {
        illegal: true
    },
    manufacturer: {
        presence: true,
        length: { minimum: 1 }
    },
    model: {
        presence: true,
        length: { minimum: 1 }
    },
    hourlyCost: {
        presence: true,
        numericality: { greaterThan: 0, noStrings: true }
    },
    type: {
        presence: true,
        inclusion: [ "mountain", "road", "tandem" ]
    },
    ownerUserId: {
        presence: true
    },
    suitableHeightInMeters: {
        presence: true,
        numericality: { greaterThan: 0, noStrings: true }
    },
    maximumWeightInKg: {
        presence: true,
        numericality: { greaterThan: 0, noStrings: true }
    }
};

var app = express();
app.use(morgan("dev"));
app.use(bodyParser.json());

// api ------------------------------------------------------------

// find bike ------------------------------------------------------------
app.get('/api/availableBikes', function (req, res) {
    var query = { available: true };
    // Add user filter conditions
    for (var queryParam in req.query) {
        if (isNaN(req.query[queryParam])) {
            query[queryParam] = req.query[queryParam];
        }
        else {
            query[queryParam] = parseFloat(req.query[queryParam]);
        }
    }

    var cursor = mongoDB.collection(mongoDBCollection).find(query).sort({ hourlyCost: 1 }).limit(10);
    cursor.toArray(function(err, data) {
        if (err) {
            dbError(res, err);
            return;
        }

        data.forEach(function(bike) {
            bike.id = bike._id;
            delete bike._id;
        });

        res.send(data);
    });
});

// new bike ------------------------------------------------------------
app.post('/api/bikes', function (req, res) {
    var validationErrors = validate(req.body, incomingBikeSchema);
    if (validationErrors) {
        res.status(400).send(validationErrors);
        return;
    }

    var newBike = req.body;
    newBike.available = true;

    mongoDB.collection(mongoDBCollection).insertOne(newBike, function(err, result) {
        if (err) {
            dbError(res, err);
            return;
        }
        
        newBike.id = newBike._id;
        delete newBike._id;
        console.log('inserted new bikeId: ' + newBike.id);
        res.send(newBike);
    });
});

// update bike ------------------------------------------------------------
app.put('/api/bikes/:bikeId', function(req, res) {
    var validationErrors = validate(req.body, incomingBikeSchema);
    if (validationErrors) {
        res.status(400).send(validationErrors);
        return;
    }

    var updatedBike = req.body;

    mongoDB.collection(mongoDBCollection).updateOne({ _id: new ObjectId(req.params.bikeId) }, { $set: updatedBike }, function(err, result) {
        if (err) {
            dbError(res, err);
            return;
        }
        if (!result) {
            res.status(500).send('DB response was null!');
            return;
        }
        if (result.matchedCount === 0) {
            bikeDoesNotExist(res, req.params.bikeId);
            return;
        }
        if (result.matchedCount !== 1 && result.modifiedCount !== 1) {
            var msg = 'Unexpected number of bikes modified! Matched: "' + result.matchedCount + '" Modified: "' + result.modifiedCount + '"';
            console.log(msg);
            res.status(500).send(msg);
            return;
        }

        res.sendStatus(200);
    });
});

// get bike ------------------------------------------------------------
app.get('/api/bikes/:bikeId', function(req, res) {
    if (!req.params.bikeId) {
        res.status(400).send('Must specify bikeId');
        return;
    }

    mongoDB.collection(mongoDBCollection).findOne({ _id: new ObjectId(req.params.bikeId) }, function(err, result) {
        if (err) {
            dbError(res, err);
            return;
        }
        if (!result) {
            bikeDoesNotExist(res, req.params.bikeId);
            return;
        }

        var theBike = result;
        theBike.id = theBike._id;
        delete theBike._id;

        res.send(theBike);
    });
});

// delete bike ------------------------------------------------------------
app.delete('/api/bikes/:bikeId', function(req, res) {
    if (!req.params.bikeId) {
        res.status(400).send('Must specify bikeId');
        return;
    }
    
    mongoDB.collection(mongoDBCollection).deleteOne({ _id: new ObjectId(req.params.bikeId) }, function(err, result) {
        if (err) {
            dbError(res, err);
            return;
        }
        if (result.deletedCount === 0) {
            bikeDoesNotExist(res, req.params.bikeId);
            return;
        }
        if (result.deletedCount !== 1) {
            var msg = 'Unexpected number of bikes deleted! Deleted: "' + result.deletedCount + '"';
            console.log(msg);
            res.status(500).send(msg);
            return;
        }
        
        res.sendStatus(200);
    });
});

// reserve bike ------------------------------------------------------------
app.patch('/api/bikes/:bikeId/reserve', function(req, res) {
    if (!req.params.bikeId) {
        res.status(400).send('Must specify bikeId');
        return;
    }

    processReservation(res, req.params.bikeId, false);
});

// clear bike ------------------------------------------------------------
app.patch('/api/bikes/:bikeId/clear', function(req, res) {
    if (!req.params.bikeId) {
        res.status(400).send('Must specify bikeId');
        return;
    }

    processReservation(res, req.params.bikeId, true);
});

function processReservation(res, bikeId, changeTo) {
    mongoDB.collection(mongoDBCollection).updateOne({ _id: new ObjectId(bikeId), available: !changeTo }, { $set: { available: changeTo } }, function(err, result) {
        if (err) {
            dbError(res, err);
            return;
        }
        if (result.matchedCount === 0) {
            // Figure out if bike does not exist or if it was invalid reservation request
            mongoDB.collection(mongoDBCollection).findOne({ _id: new ObjectId(bikeId) }, function(err, result) {
                if (err) {
                    dbError(res, err);
                    return;
                }

                if (!result) {
                    bikeDoesNotExist(res, bikeId);
                }
                else {
                    // Invalid reservation request
                    res.status(400).send('Invalid reservation request was made for BikeId ' + bikeId);
                }
            });
            
            return;
        }
        if (result.matchedCount !== 1 && result.modifiedCount !== 1) {
            var msg = 'Unexpected number of bikes changed availability! Matched: "' + result.matchedCount + '" Modified: "' + result.modifiedCount + '"';
            console.log(msg);
            res.status(500).send(msg);
            return;
        }

        res.sendStatus(200);
    });
}

function bikeDoesNotExist(res, bikeId) {
    res.status(404).send('BikeId "' + bikeId + '" does not exist!');
}

function dbError(res, err) {
    console.log(err);
    res.status(500).send(err);
}

app.get('/hello', function(req, res) {
    res.send('hello!');
});

// start server ------------------------------------------------------------
var port = 80;
var server = null;

MongoClient.connect(mongoDBConnStr, function(err, db) {
    if (err) {
        console.error("Mongo connection error!");
        console.error(err);
        process.exit(1);
    }

    console.log("Connected to MongoDB");
    mongoDB = db;

    // Start server
    server = app.listen(port, function () {
        console.log('Listening on port ' + port);
    });
});

process.on("SIGINT", () => {
    process.exit(130 /* 128 + SIGINT */);
});

process.on("SIGTERM", () => {
    console.log("Terminating...");
    if (server) {
        server.close();
    }
    mongoDB.close();
});
